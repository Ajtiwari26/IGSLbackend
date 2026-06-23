const Redis = require('ioredis');
const logger = require('./logger');

let redisClient = null;

if (process.env.NODE_ENV !== 'test' && process.env.REDIS_URI) {
  try {
    // ioredis automatically enables TLS when the protocol is rediss://
    redisClient = new Redis(process.env.REDIS_URI, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      }
    });

    redisClient.on('connect', () => {
      logger.info('Connected to Upstash Redis successfully.');
    });

    redisClient.on('error', (err) => {
      logger.error('Redis error encountered:', { error: err.message });
    });
  } catch (err) {
    logger.error('Failed to initialize Redis client:', { error: err.message });
  }
}

async function getCache(key) {
  if (!redisClient) return null;
  try {
    const val = await redisClient.get(key);
    if (val) {
      logger.info(`[Redis] Cache hit for key: ${key}`);
      return JSON.parse(val);
    }
    logger.info(`[Redis] Cache miss for key: ${key}`);
    return null;
  } catch (err) {
    logger.error(`[Redis] getCache failed for key: ${key}`, { error: err.message });
    return null;
  }
}

async function setCache(key, data, ttlSeconds = parseInt(process.env.REDIS_CACHE_TTL || '3600')) {
  if (!redisClient) return false;
  try {
    const value = JSON.stringify(data);
    await redisClient.set(key, value, 'EX', ttlSeconds);
    logger.info(`[Redis] Cache set for key: ${key} with TTL: ${ttlSeconds}s`);
    return true;
  } catch (err) {
    logger.error(`[Redis] setCache failed for key: ${key}`, { error: err.message });
    return false;
  }
}

async function delCache(key) {
  if (!redisClient) return false;
  try {
    await redisClient.del(key);
    logger.info(`[Redis] Cache cleared for key: ${key}`);
    return true;
  } catch (err) {
    logger.error(`[Redis] delCache failed for key: ${key}`, { error: err.message });
    return false;
  }
}

async function clearCachePattern(pattern) {
  if (!redisClient) return false;
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
      logger.info(`[Redis] Cleared ${keys.length} cache keys matching pattern: ${pattern}`);
    }
    return true;
  } catch (err) {
    logger.error(`[Redis] clearCachePattern failed for pattern: ${pattern}`, { error: err.message });
    return false;
  }
}

module.exports = {
  redisClient,
  getCache,
  setCache,
  delCache,
  clearCachePattern
};
