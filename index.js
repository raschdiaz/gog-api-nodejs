import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

// GOG OAuth Client Credentials
const CLIENT_ID = '46899977096215655';
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

// Config & Persistence
const TOKENS_FILE = './tokens.json';
const CONFIG_FILE = './config.json';
const DEFAULT_DOWNLOAD_DIR = './gog_offline_backup';
const TARGET_PLATFORM = 'windows'; // Options: 'windows', 'mac', 'linux'
const TARGET_LANGUAGE = 'English';

/**
 * Load tokens from disk if present
 */
function loadStoredTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[Auth] Saved updated tokens to ${TOKENS_FILE}`);
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

  switch (unit?.toUpperCase()) {
    case 'GB':
      return Math.round(numValue * 1024 * 1024 * 1024);
    case 'MB':
      return Math.round(numValue * 1024 * 1024);
    case 'KB':
      return Math.round(numValue * 1024);
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
async function getGameDetails(gameId, accessToken) {
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

      const platformFiles = group[1]?.[TARGET_PLATFORM];
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
 * Resumable file downloader
 */
async function downloadFileWithResume(manualUrl, savePath, accessToken) {
  let existingSize = 0;
  if (fs.existsSync(savePath)) {
    existingSize = fs.statSync(savePath).size;
  }

  const requestHeaders = getHeaders(accessToken);
  if (existingSize > 0) {
    requestHeaders['Range'] = `bytes=${existingSize}-`;
  }

  const res = await fetch(`https://embed.gog.com${manualUrl}`, {
    headers: requestHeaders,
    redirect: 'follow'
  });

  if (res.status === 416) {
    console.log(`  File is already complete (${formatBytes(existingSize)}).`);
    return;
  }

  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const isPartial = res.status === 206;
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const totalSize = isPartial ? existingSize + contentLength : contentLength;
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

  await pipeline(nodeReadable, fileStream);
  drawProgressBar(existingSize + downloadedInSession, totalSize, 0);
  process.stdout.write('\n');

  // Post-download check: Rename file if the final URL has a better name
  let finalPath = savePath;
  if (!path.extname(finalPath)) {
    let newName = null;
    const contentDisposition = res.headers.get('content-disposition');
    // 1. Try to get name from Content-Disposition header
    if (contentDisposition) {
      const match = contentDisposition.match(/filename\*?=['"]?([^'"]+)['"]?/);
      if (match && match[1]) {
        newName = decodeURIComponent(match[1]);
      }
    }
    // 2. Fallback to final URL path
    if (!newName) {
      const urlPath = new URL(finalUrl).pathname;
      newName = path.basename(urlPath);
    }
    // 3. If still no extension, assume .exe for Windows platform
    if (newName && !path.extname(newName) && TARGET_PLATFORM === 'windows') {
      newName += '.exe';
    }
    // 4. Rename the file if we found a better name
    if (newName && newName !== path.basename(finalPath)) {
      const newPath = path.join(path.dirname(finalPath), newName);
      fs.renameSync(finalPath, newPath);
      console.log(`  File renamed to ${newName}`);
    }
  }
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
    const accessToken = await getValidAccessToken();

    const rl = readline.createInterface({ input: stdin, output: stdout });

    const config = loadConfig();
    const lastDownloadDir = config.downloadDir || DEFAULT_DOWNLOAD_DIR;
    const lastTags = config.tags || [];

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

    const tagsInput = await rl.question(
      `Enter tags to filter by (or press Enter for default: ${lastTagsString || 'all'}): `
    );
    rl.close();
    
    const targetTags = tagsInput.trim()
      ? tagsInput.split(',').map(tag => tag.trim())
      : lastTags;

    // Save the latest settings for the next run
    saveConfig({ downloadDir: downloadDir, tags: targetTags });

    if (targetTags.length > 0) {
      console.log(`\nFiltering for games with tags: ${targetTags.join(', ')}`);
    }

    console.log(`\nUsing download directory: ${path.resolve(downloadDir)}`);
    console.log('Fetching GOG library...');
    const gameIds = await fetchOwnedGames(accessToken);
    console.log(`Found ${gameIds.length} owned games.\n`);
    let gamesToDownload = 0;

    for (const gameId of gameIds) {
      const gameDetails = await getGameDetails(gameId, accessToken);
      if (!gameDetails || gameDetails.installers.length === 0) {
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

      // Check if game is already fully downloaded
      const gameFolderName = gameDetails.title.replace(/[/\\?%*:|"<>]/g, '');
      const gameDir = path.join(downloadDir, gameFolderName);
      if (fs.existsSync(gameDir)) {
        let isComplete = true;
        const existingFiles = new Map(
          fs.readdirSync(gameDir).map(f => {
            try {
              return [f, fs.statSync(path.join(gameDir, f)).size];
            } catch {
              return [f, -1]; // Handle cases where stat might fail
            }
          })
        );

        for (const installer of gameDetails.installers) {
          const expectedSize = parseSizeToBytes(installer.size);
          const existingSize = existingFiles.get(installer.name);
          if (existingSize === undefined || existingSize < expectedSize) {
            isComplete = false;
            break;
          }
        }
        if (isComplete) {
          console.log(`[${gameDetails.title}] is already complete. Skipping.`);
          continue;
        }
      }

      gamesToDownload++;

      for (const item of gameDetails.installers) {
        const folderName = item.gameTitle.replace(/[/\\?%*:|"<>]/g, '');
        const targetDir = path.join(downloadDir, folderName);
        fs.mkdirSync(targetDir, { recursive: true });

        let fileName = item.name;
        // If the API-provided name doesn't have an extension, try to get it from the URL.
        if (!path.extname(fileName)) {
          const urlSegments = item.manualUrl.split('/');
          const nameFromUrl = urlSegments[urlSegments.length - 1];
          // Use the name from the URL only if it seems valid (not a generic ID).
          if (nameFromUrl && path.extname(nameFromUrl)) {
            fileName = nameFromUrl;
          }
        }
        fileName = fileName.replace(/[/\\?%*:|"<>]/g, '_');
        const filePath = path.join(targetDir, fileName);

        console.log(`[${item.gameTitle}] -> ${fileName}`);
        await downloadFileWithResume(item.manualUrl, filePath, accessToken);
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