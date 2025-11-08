// index.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const app = express();

const PORT = process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || null;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 3600);
const FILE_CACHE_DIR = process.env.FILE_CACHE_DIR || './cache';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 200);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);

// Basic security
app.use(helmet());
app.use(morgan('combined'));

// Rate limiter
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Ensure cache dir exists
if (!fsSync.existsSync(FILE_CACHE_DIR)) {
  fsSync.mkdirSync(FILE_CACHE_DIR, { recursive: true });
}

// Simple in-memory cache (maps key -> { expires: timestamp, headers, buffer })
const memCache = new Map();

function cacheKeyFromReq(req) {
  // Use the path+query (except key param) as cache key
  const url = new URL(req.originalUrl, `http://${req.hostname}`);
  url.searchParams.delete('key');
  return url.pathname + url.search;
}

async function readFileCache(key) {
  const file = path.join(FILE_CACHE_DIR, encodeURIComponent(key));
  try {
    const meta = JSON.parse(await fs.readFile(file + '.json', 'utf8'));
    const now = Date.now();
    if (meta.expires < now) {
      await fs.unlink(file + '.json').catch(()=>{});
      await fs.unlink(file + '.bin').catch(()=>{});
      return null;
    }
    const buffer = await fs.readFile(file + '.bin');
    return { headers: meta.headers, buffer };
  } catch (e) {
    return null;
  }
}

async function writeFileCache(key, headers, buffer) {
  const file = path.join(FILE_CACHE_DIR, encodeURIComponent(key));
  const meta = {
    expires: Date.now() + CACHE_TTL_SECONDS * 1000,
    headers
  };
  try {
    await fs.writeFile(file + '.json', JSON.stringify(meta), 'utf8');
    await fs.writeFile(file + '.bin', buffer);
  } catch (e) {
    console.warn('File cache write failed', e.message);
  }
}

// Simple helper to forward fetch and stream it back
async function forwardFetch(targetUrl, req) {
  // Add a User-Agent to be polite
  const headers = {
    'User-Agent': req.headers['user-agent'] || 'roblox-proxy/1.0',
    Accept: req.headers.accept || '*/*'
  };

  // For GET only in this simple proxy
  const res = await fetch(targetUrl, { method: 'GET', headers, redirect: 'follow' });

  const buffer = await res.buffer();
  // Extract useful headers
  const outHeaders = {};
  const copyHeaders = ['content-type','content-length','cache-control','last-modified','etag'];
  for (const h of copyHeaders) {
    const val = res.headers.get(h);
    if (val) outHeaders[h] = val;
  }
  return { status: res.status, headers: outHeaders, buffer };
}

// Middleware: optional access key
app.use((req, res, next) => {
  if (!ACCESS_KEY) return next();
  const key = req.query.key || req.headers['x-access-key'] || '';
  if (key !== ACCESS_KEY) {
    return res.status(401).json({ error: 'invalid access key' });
  }
  next();
});

// Example route: proxy arbitrary Roblox endpoints under /proxy/*
// Usage: /proxy/https://thumbnails.roblox.com/v1/players/avatar?userId=1
app.get('/proxy/*', async (req, res) => {
  try {
    const incoming = req.params[0]; // everything after /proxy/
    if (!incoming) return res.status(400).json({ error: 'no target' });

    // Validate: only allow requests to official Roblox hosts
    const allowedHosts = ['thumbnails.roblox.com','assetdelivery.roblox.com','catalog.roblox.com','www.roblox.com','images.rbxcdn.com','rthumbnails.roblox.com'];
    let target;
    try {
      target = new URL(incoming);
    } catch (e) {
      // maybe it's a path + query (like thumbnails.roblox.com/v1/...), try to build URL
      const maybe = 'https://' + incoming.replace(/^\/+/, '');
      target = new URL(maybe);
    }
    if (!allowedHosts.includes(target.hostname)) {
      return res.status(403).json({ error: 'host not allowed' });
    }

    const ck = cacheKeyFromReq(req);
    // Check memory cache
    const now = Date.now();
    const memEntry = memCache.get(ck);
    if (memEntry && memEntry.expires > now) {
      // serve from memory
      for (const [k,v] of Object.entries(memEntry.headers)) res.setHeader(k, v);
      return res.status(200).send(memEntry.buffer);
    }

    // Check file cache
    const fileEntry = await readFileCache(ck);
    if (fileEntry) {
      for (const [k,v] of Object.entries(fileEntry.headers)) res.setHeader(k, v);
      // warm memory cache
      memCache.set(ck, { expires: Date.now() + CACHE_TTL_SECONDS*1000, headers: fileEntry.headers, buffer: fileEntry.buffer });
      return res.status(200).send(fileEntry.buffer);
    }

    // Fetch from Roblox
    const fetchResult = await forwardFetch(target.toString(), req);

    // store in caches if 200
    if (fetchResult.status === 200) {
      // set headers on response
      for (const [k,v] of Object.entries(fetchResult.headers)) {
        res.setHeader(k, v);
      }
      // default cache control if not present
      if (!res.getHeader('cache-control')) {
        res.setHeader('cache-control', `public, max-age=${CACHE_TTL_SECONDS}`);
      }

      // write to mem + file cache
      memCache.set(ck, { expires: Date.now() + CACHE_TTL_SECONDS*1000, headers: fetchResult.headers, buffer: fetchResult.buffer });
      // keep mem cache size reasonable
      if (memCache.size > 1000) {
        // basic trim (not LRU)
        const keys = memCache.keys();
        memCache.delete(keys.next().value);
      }
      // async write file cache (no await hold)
      writeFileCache(ck, fetchResult.headers, fetchResult.buffer).catch(()=>{});

      return res.status(200).send(fetchResult.buffer);
    } else {
      // pass through non-200 status
      return res.status(fetchResult.status).send(fetchResult.buffer);
    }
  } catch (err) {
    console.error('Proxy error', err);
    return res.status(500).json({ error: 'proxy error', message: err.message });
  }
});

// Simple health
app.get('/', (req, res) => {
  res.send('roblox-proxy up');
});

app.listen(PORT, () => {
  console.log(`roblox-proxy listening on port ${PORT}`);
});
