const { getCache, setCache, delCache, clearCachePattern } = require('./utils/redis');
const logger = require('./utils/logger');

/**
 * Hybrid L1 (In-Memory) & L2 (Redis) Cache with TTL
 */
class HybridCache {
  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
    this.localCache = new Map();
  }

  async set(key, value, ttlSeconds = 300) {
    try {
      // 1. Store in Upstash Redis (L2)
      await setCache(key, value, ttlSeconds);
    } catch (err) {
      logger.error(`[Cache] Redis L2 set failed for key: ${key}`, { error: err.message });
    }

    // 2. Store in local Memory Map (L1)
    if (this.localCache.size >= this.maxSize) {
      const oldestKey = this.localCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.localCache.delete(oldestKey);
      }
    }

    if (this.localCache.has(key)) {
      this.localCache.delete(key);
    }

    const expiresAt = Date.now() + (ttlSeconds * 1000);
    this.localCache.set(key, { value, expiresAt });
    return value;
  }

  async get(key) {
    // 1. Try Memory Map (L1) first for lightning fast access
    const entry = this.localCache.get(key);
    if (entry && Date.now() <= entry.expiresAt) {
      logger.info(`[Cache] Memory L1 hit for key: ${key}`);
      return entry.value;
    }

    // 2. Fallback to Upstash Redis (L2)
    try {
      const redisVal = await getCache(key);
      if (redisVal !== null) {
        // Sync back to L1
        const expiresAt = Date.now() + (300 * 1000); // default 5m local TTL
        this.localCache.set(key, { value: redisVal, expiresAt });
        return redisVal;
      }
    } catch (err) {
      logger.error(`[Cache] Redis L2 get failed for key: ${key}`, { error: err.message });
    }

    return null;
  }

  async delete(key) {
    try {
      // 1. Invalidate Redis (L2)
      await delCache(key);
    } catch (err) {
      logger.error(`[Cache] Redis L2 delete failed for key: ${key}`, { error: err.message });
    }

    // 2. Invalidate Memory (L1)
    return this.localCache.delete(key);
  }

  async clear() {
    this.localCache.clear();
  }

  async invalidatePrefix(prefix) {
    try {
      // 1. Invalidate Redis (L2) matching keys
      await clearCachePattern(`${prefix}*`);
    } catch (err) {
      logger.error(`[Cache] Redis L2 pattern clear failed for prefix: ${prefix}`, { error: err.message });
    }

    // 2. Invalidate Memory (L1) matching keys
    for (const key of this.localCache.keys()) {
      if (key.startsWith(prefix)) {
        this.localCache.delete(key);
      }
    }
  }
}

const cache = new HybridCache(2000);
module.exports = cache;
