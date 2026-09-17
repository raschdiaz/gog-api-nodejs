import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { spawn } from 'child_process';
import { stdin, stdout } from 'process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

// GOG OAuth Client Credentials
const CLIENT_ID = '46899977096215655';
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

// Config & Persistence
const CONFIG_FILE = './config.json';
const DEFAULT_DOWNLOAD_DIR = './gog_offline_backup';
const DEFAULT_TARGET_PLATFORM = 'windows'; // Options: 'windows', 'mac', 'linux', 'all'
const SUPPORTED_PLATFORMS = ['windows', 'mac', 'linux', 'all'];
const TARGET_LANGUAGE = 'English';

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (SUPPORTED_PLATFORMS.includes(normalized)) return normalized;
  return null;
}

/**
 * Load tokens from disk if present
 */
function loadStoredTokens() {
  const config = loadConfig();
  return config.tokens || null;
}

/**
 * Save tokens to disk along with creation timestamp
 */
function saveTokens(tokenData) {
  const payload = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in || 3600,
    saved_at: Date.now()
  };
  saveConfig({ tokens: payload });
  console.log(`[Auth] Saved updated tokens to ${CONFIG_FILE}`);
}

/**
 * Load config from disk if present
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Save config to disk
 */
function saveConfig(configData) {
  const currentConfig = loadConfig();
  const newConfig = { ...currentConfig, ...configData };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
}

/**
 * Step 1-3: Interactive Browser Authentication
 */
async function authenticateInteractive() {
  const authUrl = `https://auth.gog.com/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&layout=client2`;

  console.log('\n=== GOG Manual Authentication Required ===');
  console.log('1. Open this URL in your browser and log in:\n');
  console.log(authUrl);
  console.log('\n==========================================\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const userInput = await rl.question('Enter the authorization code (or full redirect URL): ');
  rl.close();

  let code = userInput.trim();
  if (code.includes('code=')) {
    try {
      const parsedUrl = new URL(code);
      code = parsedUrl.searchParams.get('code') || code;
    } catch {
      const match = code.match(/code=([^&]+)/);
      if (match) code = match[1];
    }
  }

  const redirectUrlWithCode = `${REDIRECT_URI}&code=${code}`;
  console.log('\nStep 2 Success URL:');
  console.log(redirectUrlWithCode);

  console.log('\nExchanging authorization code for tokens...');
  const tokenParams = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI
  });

  const res = await fetch('https://auth.gog.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${errorText}`);
  }

  const tokenData = await res.json();
  console.log('Authentication successful!');
  return tokenData;
}

/**
 * Use refresh_token to obtain a new access_token automatically
 */
async function refreshAccessToken(refreshToken) {
  const tokenParams = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const res = await fetch('https://auth.gog.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${errorText}`);
  }

  return await res.json();
}

/**
 * Get a guaranteed valid access_token (reads cache -> refreshes -> prompts)
 */
async function getValidAccessToken() {
  const stored = loadStoredTokens();

  if (stored && stored.access_token) {
    // Check if current token is expired (60s buffer)
    const isExpired = Date.now() >= (stored.saved_at || 0) + ((stored.expires_in || 3600) - 60) * 1000;

    if (!isExpired) {
      console.log('[Auth] Using active stored access token from tokens.json.');
      return stored.access_token;
    }

    if (stored.refresh_token) {
      console.log('[Auth] Access token expired. Attempting automatic refresh...');
      try {
        const newTokens = await refreshAccessToken(stored.refresh_token);
        saveTokens(newTokens);
        return newTokens.access_token;
      } catch (err) {
        console.warn(`[Auth] Refresh failed (${err.message}). Falling back to interactive login...`);
      }
    }
  }

  // No valid tokens or refresh failed: perform manual auth
  const newTokens = await authenticateInteractive();
  saveTokens(newTokens);
  return newTokens.access_token;
}

/**
 * Build standard headers
 */
function getHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  };
}

/**
 * Format bytes to human-readable units
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Terminal progress bar render
 */
function drawProgressBar(downloaded, total, speedBytesPerSec) {
  const barLength = 20;
  const hasTotal = total > 0;
  const percentage = hasTotal ? (downloaded / total) * 100 : 0;

  const filledLength = hasTotal ? Math.min(barLength, Math.round((barLength * percentage) / 100)) : 0;
  const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

  const remainingBytes = total - downloaded;
  const etaSeconds = speedBytesPerSec > 0 && remainingBytes > 0 
    ? Math.ceil(remainingBytes / speedBytesPerSec) 
    : 0;

  const pctString = hasTotal ? `${percentage.toFixed(1).padStart(5)}%` : '  N/A';
  const totalString = hasTotal ? formatBytes(total) : 'Unknown';
  const etaString = etaSeconds > 0 ? `${etaSeconds}s` : '--';

  process.stdout.write(
    `\r  [${bar}] ${pctString} | ${formatBytes(downloaded)} / ${totalString} | ${formatBytes(speedBytesPerSec)}/s | ETA: ${etaString}`
  );
}

/**
 * Parse size string (e.g., "1.2 GB") into bytes
 */
function parseSizeToBytes(sizeString) {
  if (!sizeString || typeof sizeString !== 'string') return 0;
  const [value, unit] = sizeString.split(' ');
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return 0;

  const k = 1024;
  switch (unit?.toUpperCase()) {
    case 'GB':
      return Math.round(numValue * k * k * k); // Use base-2 (GiB)
    case 'MB':
      return Math.round(numValue * k * k);     // Use base-2 (MiB)
    case 'KB':
      return Math.round(numValue * k);         // Use base-2 (KiB)
    default:
      return Math.round(numValue);
  }
}

/**
 * Fetch owned game IDs
 */
async function fetchOwnedGames(accessToken) {
  const res = await fetch('https://embed.gog.com/user/data/games', { headers: getHeaders(accessToken) });
  if (!res.ok) throw new Error(`Library fetch failed: ${res.statusText}`);
  const data = await res.json();
  return data.owned;
}

/**
 * Fetch game details, including installer links and tags
 */
async function getGameDetails(gameId, accessToken, targetPlatform = DEFAULT_TARGET_PLATFORM) {
  const res = await fetch(`https://embed.gog.com/account/gameDetails/${gameId}.json`, { headers: getHeaders(accessToken) });
  if (!res.ok) return null;

  const data = await res.json();
  const installers = [];
  const gameTags = Array.isArray(data.tags)
    ? data.tags.map(tag => tag.name)
    : [];

  if (data.downloads && Array.isArray(data.downloads)) {
    for (const group of data.downloads) {
      const languageName = group[0];
      // Filter by language
      if (languageName.toLowerCase() !== TARGET_LANGUAGE.toLowerCase()) continue;

      const platformFiles = group[1]?.[targetPlatform];
      if (Array.isArray(platformFiles)) {
        for (const file of platformFiles) {
          // We still need the game title for the folder name later
          installers.push({
            gameTitle: data.title,
            name: file.name,
            manualUrl: file.manualUrl,
            size: file.size
          });
        }
      }
    }
  }
  return {
    title: data.title,
    tags: gameTags,
    installers: installers
  };
}

/**
 * Downloader using curl for more reliable large-file transfer, resume support,
 * and network retry behavior compared to the raw fetch() stream.
 */
async function downloadFileWithCurl(downloadUrl, savePath, accessToken, allowRangeRestart = true) {
  const headers = getHeaders(accessToken);
  const curlArgs = [
    '--fail',
    '--location',
    '--connect-timeout', '15',
    '--max-time', '0',
    '--http1.1',
    '--user-agent', headers['User-Agent'],
    '--header', `Authorization: Bearer ${accessToken}`,
    '--write-out', '%{http_code}',
    '--output', savePath
  ];

  const existingSize = fs.existsSync(savePath) ? fs.statSync(savePath).size : 0;
  if (existingSize > 0) {
    curlArgs.push('--continue-at', '-');
    console.log(`  Resuming download from byte offset ${formatBytes(existingSize)}...`);
  }

  const curl = spawn('curl', [...curlArgs, downloadUrl], {
    stdio: ['ignore', 'pipe', 'inherit']
  });

  await new Promise((resolve, reject) => {
    let httpStatus = '';
    curl.stdout.on('data', (chunk) => {
      httpStatus += chunk.toString();
    });
    curl.on('error', (error) => reject(error));
    curl.on('close', (code) => {
      if (code === 0) resolve();
      else if (code === 22 && httpStatus.trim() === '416' && existingSize > 0 && allowRangeRestart) {
        fs.unlinkSync(savePath);
        console.warn('  Server rejected the resume offset; restarting this file from byte zero.');
        downloadFileWithCurl(downloadUrl, savePath, accessToken, false).then(resolve, reject);
      }
      else {
        const error = new Error(`curl exited with code ${code}${httpStatus ? ` (HTTP ${httpStatus.trim()})` : ''}`);
        error.code = 'ERR_DOWNLOAD_CURL';
        reject(error);
      }
    });
  });
}

/**
 * Resumable file downloader
 */
async function downloadFileWithResume(manualUrl, savePath, accessToken) {
  const downloadUrl = `https://embed.gog.com${manualUrl}`;

  const curlReady = await new Promise((resolve) => {
    const curlCheck = spawn('curl', ['--version'], { stdio: 'ignore' });
    curlCheck.on('error', () => resolve(false));
    curlCheck.on('close', (code) => resolve(code === 0));
  });

  if (curlReady) {
    await downloadFileWithCurl(downloadUrl, savePath, accessToken);
    return;
  }

  let existingSize = 0;
  if (fs.existsSync(savePath)) {
    existingSize = fs.statSync(savePath).size;
  }

  const requestHeaders = getHeaders(accessToken);
  if (existingSize > 0) {
    requestHeaders['Range'] = `bytes=${existingSize}-`;
  }

  const res = await fetch(downloadUrl, {
    headers: requestHeaders,
    redirect: 'follow'
  });

  if (res.status === 416) {
    const contentRange = res.headers.get('content-range');
    const totalMatch = contentRange?.match(/bytes \*\/(\d+)/i);
    const totalSize = totalMatch ? Number(totalMatch[1]) : 0;

    if (totalSize === 0 || existingSize >= totalSize) {
      console.log(`  File is already complete (${formatBytes(existingSize)}).`);
      return;
    }

    throw new Error(`HTTP 416: the existing partial file is larger than the remote file`);
  }

  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const isPartial = existingSize > 0 && res.status === 206;
  const contentRange = res.headers.get('content-range');
  let remoteTotalSize = 0;
  if (existingSize > 0 && res.status === 200) {
    console.warn('  Server ignored the resume request; restarting this file from the beginning.');
  }
  if (isPartial) {
    const rangeMatch = contentRange?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/i);
    if (!rangeMatch || Number(rangeMatch[1]) !== existingSize) {
      throw new Error('HTTP 206: server returned an invalid range for the existing partial file');
    }
    if (rangeMatch[2] !== '*') {
      remoteTotalSize = Number(rangeMatch[2]);
    }
  }
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const totalSize = remoteTotalSize || (isPartial ? existingSize + contentLength : contentLength);
  const finalUrl = res.url; // URL after redirects

  if (isPartial) {
    console.log(`  Resuming from byte offset ${formatBytes(existingSize)}...`);
  }

  const fileStream = fs.createWriteStream(savePath, {
    flags: isPartial ? 'a' : 'w'
  });

  const nodeReadable = Readable.fromWeb(res.body);

  let downloadedInSession = 0;
  let lastReportTime = Date.now();
  let bytesSinceLastReport = 0;
  let currentSpeed = 0;

  nodeReadable.on('data', (chunk) => {
    downloadedInSession += chunk.length;
    bytesSinceLastReport += chunk.length;

    const now = Date.now();
    const timeDiff = (now - lastReportTime) / 1000;

    if (timeDiff >= 0.5) {
      currentSpeed = bytesSinceLastReport / timeDiff;
      lastReportTime = now;
      bytesSinceLastReport = 0;
    }

    drawProgressBar(existingSize + downloadedInSession, totalSize, currentSpeed);
  });

  try {
    await pipeline(nodeReadable, fileStream);
  } catch (err) {
    err.code = err.code || 'ERR_DOWNLOAD_STREAM';
    throw err;
  }

  const actualFileSize = fs.statSync(savePath).size;
  const expectedFileSize = remoteTotalSize || (contentLength > 0
    ? (isPartial ? existingSize + contentLength : contentLength)
    : 0);
  if (expectedFileSize > 0 && actualFileSize !== expectedFileSize) {
    const error = new Error(
      `Download ended early (${formatBytes(actualFileSize)} of ${formatBytes(expectedFileSize)} received)`
    );
    error.code = 'ERR_DOWNLOAD_INCOMPLETE';
    throw error;
  }

  drawProgressBar(existingSize + downloadedInSession, totalSize, 0);
  process.stdout.write('\n');

  // Post-download check: Rename file if the final URL has a better name
  let newName = null;
  const contentDisposition = res.headers.get('content-disposition');
  // 1. Always prioritize the Content-Disposition header. It's the most reliable source.
  if (contentDisposition) {
    const match = contentDisposition.match(/filename\*?=['"]?([^'"]+)['"]?/);
    if (match && match[1]) {
      newName = decodeURIComponent(match[1]);
    }
  }
  // 2. If no header, fall back to the final URL path.
  if (!newName) {
    const urlPath = new URL(finalUrl).pathname;
    newName = path.basename(urlPath);
  }
  // 3. If we found a better name that is different from the current one, rename the file.
  if (newName && newName !== path.basename(savePath)) {
    const newPath = path.join(path.dirname(savePath), newName);
    // Ensure the target path doesn't already exist, or handle it.
    // For simplicity, we'll just rename. If this causes issues, we might need to delete the target first.
    fs.renameSync(savePath, newPath);
    console.log(`  File renamed to ${newName}`);
  }
}

/**
 * Determines the most likely final filename for a download item.
 * This function is crucial for both checking existing files and for saving/resuming new ones.
 */
async function getPredictedFilename(item, accessToken, targetPlatform = DEFAULT_TARGET_PLATFORM) {
  let predictedName = item.name;

  // 1. Fetch headers to check for Content-Disposition, which is the most reliable source.
  try {
    const res = await fetch(`https://embed.gog.com${item.manualUrl}`, {
      method: 'HEAD',
      headers: getHeaders(accessToken),
      redirect: 'follow'
    });

    if (res.ok) {
      const contentDisposition = res.headers.get('content-disposition');
      if (contentDisposition) {
        const match = contentDisposition.match(/filename\*?=['"]?([^'"]+)['"]?/);
        if (match && match[1]) {
          predictedName = decodeURIComponent(match[1]);
        }
      }
      // If no Content-Disposition, use the final URL after redirects
      if (predictedName === item.name) {
        const urlPath = new URL(res.url).pathname;
        predictedName = path.basename(urlPath);
      }
    }
  } catch (e) {
    // If HEAD request fails, fall back to less reliable methods
  }

  // 2. If the name (from API or HEAD request) lacks an extension, try the original URL path.
  if (!path.extname(predictedName)) {
    try {
      const urlPath = new URL(`https://embed.gog.com${item.manualUrl}`).pathname;
      const nameFromUrl = path.basename(urlPath);
      if (nameFromUrl && path.extname(nameFromUrl)) {
        predictedName = nameFromUrl;
      }
    } catch (e) {/* Ignore malformed URL */}
  }

  // 3. If it still lacks an extension, apply the platform-specific fallback.
  if (!path.extname(predictedName) && targetPlatform === 'windows') {
    predictedName += '.exe';
  }

  // 3. Sanitize the name to remove invalid characters.
  predictedName = predictedName.replace(/[/\\?%*:|"<>]/g, '_');
  return predictedName;
}

/**
 * Fetch available user tags from GOG
 */
async function fetchAvailableTags(accessToken) {
  const res = await fetch('https://users.gog.com/v1/tags', { headers: getHeaders(accessToken) });
  if (!res.ok) {
    // Don't throw, just warn, so the script can continue without the list.
    console.warn(`\n[Tags] Could not fetch available tags: ${res.statusText}.`);
    return [];
  }
  const tagsData = await res.json();
  return Array.isArray(tagsData) ? tagsData.map(tag => tag.name) : [];
}

/**
 * Main application execution
 */
async function main() {
  try {
    // One-time migration: move tokens from tokens.json into config.json
    const LEGACY_TOKENS_FILE = './tokens.json';
    if (fs.existsSync(LEGACY_TOKENS_FILE)) {
      console.log(`[Config] Migrating tokens from legacy ${LEGACY_TOKENS_FILE} to ${CONFIG_FILE}...`);
      try {
        const raw = fs.readFileSync(LEGACY_TOKENS_FILE, 'utf8');
        const tokenData = JSON.parse(raw);
        saveConfig({ tokens: tokenData });
        fs.unlinkSync(LEGACY_TOKENS_FILE);
        console.log(`[Config] Migration complete. ${LEGACY_TOKENS_FILE} has been deleted.`);
      } catch (err) {
        console.warn(`[Config] Warning: Could not migrate tokens.json: ${err.message}. You may need to log in again.`);
      }
    }
    const accessToken = await getValidAccessToken();

    const rl = readline.createInterface({ input: stdin, output: stdout });

    const config = loadConfig();
    const lastDownloadDir = config.downloadDir || DEFAULT_DOWNLOAD_DIR;
    const lastTargetPlatform = normalizePlatform(config.targetPlatform) || DEFAULT_TARGET_PLATFORM;
    const legacyPlatform = lastTargetPlatform === 'all' ? DEFAULT_TARGET_PLATFORM : lastTargetPlatform;
    const lastTags = config.tags || [];

    // Backward compatibility: migrate 'completedGames' (array) to 'downloadedGames' (object)
    if (config.completedGames && !config.downloadedGames) {
      console.log('[Config] Migrating "completedGames" to "downloadedGames" in config.json...');
      config.downloadedGames = config.completedGames;
      delete config.completedGames;
      saveConfig(config);
    }

    // Migrate older flat/array state into platform-specific game state.
    if (Array.isArray(config.downloadedGames)) {
      console.log('[Config] Migrating "downloadedGames" from array to platform-specific object format...');
      const migratedGames = {};
      for (const gameId of config.downloadedGames) {
        migratedGames[gameId] = 'Unknown Title (migrated)';
      }
      config.downloadedGames = { [legacyPlatform]: migratedGames };
      saveConfig({ downloadedGames: config.downloadedGames });
    } else if (config.downloadedGames && !Object.values(config.downloadedGames).every(value =>
      value && typeof value === 'object' && !Array.isArray(value)
    )) {
      console.log('[Config] Migrating "downloadedGames" to platform-specific object format...');
      config.downloadedGames = { [legacyPlatform]: config.downloadedGames };
      saveConfig({ downloadedGames: config.downloadedGames });
    }

    const availableTags = await fetchAvailableTags(accessToken);
    if (availableTags.length > 0) {
      console.log('\nAvailable tags in your library:');
      // Sort and join for a clean, readable list
      console.log(availableTags.sort().join(', '));
    }

    const lastTagsString = lastTags.join(', ');
    const downloadDirInput = await rl.question(
      `\nEnter download directory (or press Enter for default: ${lastDownloadDir}): `
    );
    const downloadDir = downloadDirInput.trim() || lastDownloadDir;

    const platformInput = await rl.question(
      `Enter installer OS to download [windows/mac/linux/all] (or press Enter for default: ${lastTargetPlatform}): `
    );
    const targetPlatform = normalizePlatform(platformInput) || lastTargetPlatform;

    const tagsInput = await rl.question(
      `Enter tags to filter by (or press Enter for default: ${lastTagsString || 'all'}): `
    );
    rl.close();
    
    const targetTags = tagsInput.trim()
      ? tagsInput.split(',').map(tag => tag.trim())
      : lastTags;

    // Save the latest settings for the next run
    saveConfig({
      downloadDir: downloadDir,
      tags: targetTags,
      targetPlatform: targetPlatform
    });

    if (targetTags.length > 0) {
      console.log(`\nFiltering for games with tags: ${targetTags.join(', ')}`);
    }

    const platformsToDownload = targetPlatform === 'all'
      ? SUPPORTED_PLATFORMS.filter(platform => platform !== 'all')
      : [targetPlatform];
    console.log('Fetching GOG library...');
    const gameIds = await fetchOwnedGames(accessToken);
    console.log(`Found ${gameIds.length} owned games.\n`);
    let gamesToDownload = 0;

    for (const platform of platformsToDownload) {
      const platformDownloadedGames = config.downloadedGames?.[platform] || {};
      const platformDownloadDir = path.join(downloadDir, platform);

      for (const gameTitle of Object.values(platformDownloadedGames)) {
        if (!gameTitle || gameTitle.includes('(migrated)')) continue;

        const folderName = gameTitle.replace(/[/\\?%*:|"<>]/g, '');
        const legacyGameDir = path.join(downloadDir, folderName);
        const platformGameDir = path.join(platformDownloadDir, folderName);
        if (fs.existsSync(legacyGameDir) && !fs.existsSync(platformGameDir)) {
          fs.mkdirSync(platformDownloadDir, { recursive: true });
          fs.renameSync(legacyGameDir, platformGameDir);
          console.log(`[Config] Moved ${gameTitle} into the ${platform} folder.`);
        }
      }

      console.log(`\nUsing installer OS: ${platform}`);
      console.log(`Using download directory: ${path.resolve(platformDownloadDir)}`);

      for (const gameId of gameIds) {
      const gameDetails = await getGameDetails(gameId, accessToken, platform);
      if (!gameDetails || gameDetails.installers.length === 0) {
        continue;
      }

      // Check if the game is already marked as complete in config.json
      if (platformDownloadedGames.hasOwnProperty(gameId)) {
        console.log(`[${gameDetails.title}] is marked as complete in config.json. Skipping.`);
        continue;
      }

      // Filter by tags if any are specified
      if (targetTags.length > 0) {
        const gameTagsLower = gameDetails.tags.map(t => t.toLowerCase());
        const targetTagsLower = targetTags.map(t => t.toLowerCase());
        const hasTag = targetTagsLower.some(targetTag => gameTagsLower.includes(targetTag));
        if (!hasTag) {
          continue; // Skip this game if it doesn't have any of the target tags
        }
      }

      /*
      // == LOGIC TO SKIP ALREADY DOWNLOADED FILES ==
      // This block checks if a game's folder exists and if all its files are present and match the expected size.
      // If everything matches, it skips the game. It has been commented out to force re-downloads.
      const gameFolderName = gameDetails.title.replace(/[/\\?%*:|"<>]/g, '');
      const gameDir = path.join(platformDownloadDir, gameFolderName);
      if (fs.existsSync(gameDir)) {
        let isComplete = true;

        for (const installer of gameDetails.installers) {
          const expectedSize = parseSizeToBytes(installer.size);
          const predictedFilename = await getPredictedFilename(installer, accessToken);
          const predictedFilePath = path.join(gameDir, predictedFilename);

          if (!fs.existsSync(predictedFilePath)) {
            isComplete = false; // File doesn't exist at the predicted path
            break;
          }

          let actualSize = 0;
          try {
            actualSize = fs.statSync(predictedFilePath).size;
          } catch (e) {
            isComplete = false; // Cannot stat file, assume incomplete
            break;
          }

          // Check if the file is complete (within tolerance)
          const tolerance = expectedSize * 0.001;
          if (expectedSize > 0 && Math.abs(actualSize - expectedSize) > tolerance) {
            // File exists but size doesn't match (could be partial or incorrect)
            isComplete = false;
            break;
          }
        }

        // If isComplete is true here, it means all predicted files exist and are of correct size.
        // The post-download rename might have changed names, but we assume the predicted name
        // is what downloadFileWithResume will look for.
        // If a file was renamed, this check might fail, but the download loop will then
        // download it again, and a post-download rename will ensure it gets the correct name.
        // The key is that downloadFileWithResume will always look for the predicted name.

        if (isComplete) {
          console.log(`[${gameDetails.title}] is already complete. Skipping.`);
          continue;
        }
      }
      */

      gamesToDownload++;

      const MAX_RETRIES = 60*60; // 1 hour of retries
      const RETRY_DELAY_MS = 1000; // 1 second

      let installerIndex = 0;
      for (const item of gameDetails.installers) {
        installerIndex++;
        const totalInstallers = gameDetails.installers.length;
        const folderName = item.gameTitle.replace(/[/\\?%*:|"<>]/g, '');
        const targetDir = path.join(platformDownloadDir, folderName);
        fs.mkdirSync(targetDir, { recursive: true });

        // Use the predicted filename for saving and resuming.
        const fileName = await getPredictedFilename(item, accessToken, platform);
        let filePath = path.join(targetDir, fileName);

        // Older runs may have left a partial file under the API filename before
        // the completed download was renamed from Content-Disposition.
        const legacyFileName = item.name.replace(/[/\\?%*:|"<>]/g, '_');
        const legacyFilePath = path.join(targetDir, legacyFileName);
        if (!fs.existsSync(filePath) && legacyFileName !== fileName && fs.existsSync(legacyFilePath)) {
          filePath = legacyFilePath;
          console.log(`  Found existing partial file under legacy name; resuming ${legacyFileName}.`);
        }

        let retries = 0;
        let downloadSuccess = false;
        while (retries < MAX_RETRIES && !downloadSuccess) {
          try {
            console.log(`[${item.gameTitle}] (${installerIndex}/${totalInstallers}) -> ${fileName}`);
            await downloadFileWithResume(item.manualUrl, filePath, accessToken);
            downloadSuccess = true; // Success, exit retry loop
          } catch (err) {
            // Handle 404 Not Found errors gracefully
            if (err.message.includes('HTTP 404')) {
              console.warn(`\n  Warning: File not found on server (404). Skipping: ${fileName}`);
              downloadSuccess = true; // Mark as "success" to skip retries and move to the next file.
              break; // Exit the retry loop for this file.
            }

            const networkErrorCodes = [
              'ABORT_ERR',
              'ECONNRESET',
              'EAI_AGAIN',
              'ENETUNREACH',
              'ENOTFOUND',
              'ERR_DOWNLOAD_INCOMPLETE',
              'ERR_DOWNLOAD_CURL',
              'ERR_DOWNLOAD_STREAM',
              'ETIMEDOUT',
              'UND_ERR_CONNECT_TIMEOUT',
              'UND_ERR_SOCKET'
            ];
            const errorCodes = [
              err.code,
              err.cause?.code,
              err.cause?.cause?.code
            ];
            const isNetworkError = errorCodes.some(code => networkErrorCodes.includes(code));
            if (isNetworkError) {
              retries++;
              const reason = err.code === 'ERR_DOWNLOAD_INCOMPLETE'
                ? 'Download ended before the expected file length'
                : err.code === 'ERR_DOWNLOAD_CURL'
                  ? `Download connection failed (${err.message})`
                  : `Network error (${err.message})`;
              console.warn(`\n  ${reason}. Retrying in ${RETRY_DELAY_MS / 1000}s... (${retries}/${MAX_RETRIES})`);
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            } else {
              throw err; // Not a retriable network error, re-throw it
            }
          }
        }
        if (!downloadSuccess) {
          throw new Error(`Download for ${fileName} failed after ${MAX_RETRIES} retries.`);
        }
      }

      // After all installers for the game are downloaded, mark it as complete.
      if (gamesToDownload > 0) {
        platformDownloadedGames[gameId] = gameDetails.title;
        saveConfig({
          downloadedGames: {
            ...(config.downloadedGames || {}),
            [platform]: platformDownloadedGames
          }
        });
        console.log(`[${gameDetails.title}] successfully downloaded and marked as complete.`);
      }
    }
    }
    if (gamesToDownload > 0) {
      console.log('\nAll downloads complete!');
    } else {
      console.log('\nNo games matched the specified filters. Nothing to download.');
    }
  } catch (err) {
    console.error('\nError:', err.message);
  }
}

main();