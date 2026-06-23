const { getDb } = require('../db');
const cache = require('../cache');
const logger = require('./logger');

/**
 * Cache Warmup on bootstrap.
 * Fetches critical data like department lists and company configs
 * and pre-populates the cache.
 */
async function warmupCache() {
  // If in test environment, skip to avoid interfering with tests or requiring external Redis connection
  if (process.env.NODE_ENV === 'test') {
    logger.info('[Warmup] Test environment detected. Skipping cache warmup.');
    return;
  }

  try {
    logger.info('[Warmup] Starting cache warmup...');
    const db = getDb();

    // 1. Warm up Departments
    const departments = await db.collection('departments').find({}).toArray();
    const deptsByInst = {};
    for (const dept of departments) {
      const inst = dept.institution || 'IGSL';
      if (!deptsByInst[inst]) deptsByInst[inst] = [];
      deptsByInst[inst].push(dept);
    }
    
    for (const [inst, list] of Object.entries(deptsByInst)) {
      const cacheKey = `depts:${inst}`;
      await cache.set(cacheKey, list, 3600);
      logger.info(`[Warmup] Pre-populated cache for key: ${cacheKey} (${list.length} departments)`);
    }

    // 2. Warm up Companies
    const companies = await db.collection('companies').find({}).toArray();
    for (const company of companies) {
      const inst = company.institution || 'IGSL';
      const cacheKey = `company:${company._id.toString()}:${inst}`;
      await cache.set(cacheKey, company, 900);
      logger.info(`[Warmup] Pre-populated cache for key: ${cacheKey}`);
    }

    logger.info('[Warmup] Cache warmup completed successfully.');
  } catch (err) {
    logger.error('[Warmup] Error during cache warmup', { error: err.message });
  }
}

module.exports = { warmupCache };
