/**
 * In-Process Light Weight Memory Cache with TTL and Max Size (LRU behavior)
 */

class SimpleCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  set(key, value, ttlSeconds = 300) {
    // If cache exceeds max size, delete the oldest item (first key in insertion order)
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    // Delete existing to re-insert at end of insertion list (LRU update)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    const expiresAt = Date.now() + (ttlSeconds * 1000);
    this.cache.set(key, { value, expiresAt });
    return value;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Refresh insertion order (LRU update)
    const val = entry.value;
    const expiresAt = entry.expiresAt;
    this.cache.delete(key);
    this.cache.set(key, { value: val, expiresAt });

    return val;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  // Helper to invalidate by key prefix (e.g., "trip:")
  invalidatePrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}

// Global cache instance
const cache = new SimpleCache(2000);

module.exports = cache;
