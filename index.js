import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin, stdout } from 'process';
import {
  CONFIG_FILE,
  getLatestInstallerModifiedDate,
  loadConfig,
  normalizeAllDownloadedGames,
  normalizeDownloadedGameState,
  saveConfig
} from './config-store.js';
import {
  loadStoredTokens,
  saveTokens
} from './config-store.js';
import {
  fetchOwnedGames,
  getGameDetails,
  getHeaders
} from './gog-api.js';
import { processGameInstallers } from './game-downloader.js';

const CLIENT_ID = '46899977096215655';
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';
const DEFAULT_DOWNLOAD_DIR = './gog_offline_backup';
const DEFAULT_TARGET_PLATFORM = 'windows';
const SUPPORTED_PLATFORMS = ['windows', 'mac', 'linux', 'all'];

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (SUPPORTED_PLATFORMS.includes(normalized)) return normalized;
  return null;
}

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
 * Determines the most likely final filename for a download item.
 * This function is crucial for both checking existing files and for saving/resuming new ones.
 */
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

    // Normalize downloadedGames to platform -> gameId -> { title, parts: [...] }
    if (config.downloadedGames && typeof config.downloadedGames === 'object') {
      const normalizedDownloadState = normalizeAllDownloadedGames(config.downloadedGames);

      if (JSON.stringify(config.downloadedGames) !== JSON.stringify(normalizedDownloadState)) {
        console.log('[Config] Normalizing "downloadedGames" to part-level state...');
        config.downloadedGames = normalizedDownloadState;
        saveConfig({ downloadedGames: config.downloadedGames });
      }
    } else {
      console.log('[Config] Initializing "downloadedGames" state...');
      config.downloadedGames = { [legacyPlatform]: {} };
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

      for (const gameEntry of Object.values(platformDownloadedGames)) {
        const gameTitle = typeof gameEntry === 'string'
          ? gameEntry
          : (gameEntry && typeof gameEntry.title === 'string' ? gameEntry.title : null);

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

      // Remove old whole-game completion marker in favor of per-part tracking.
      const savedGameState = normalizeDownloadedGameState(gameId, platformDownloadedGames[gameId], gameDetails.title);
      const savedPartNames = new Set(savedGameState.parts);
      const completedPartNames = new Set();
      const latestModifiedDate = getLatestInstallerModifiedDate(gameDetails.installers);
      const isOutdated = savedGameState.downloadedDate
        && latestModifiedDate
        && Date.parse(savedGameState.downloadedDate) < Date.parse(latestModifiedDate);

      if (isOutdated) {
        console.log(`[${gameDetails.title}] Installer files were modified on GOG after the previous download. Re-downloading all parts.`);
        savedPartNames.clear();
        platformDownloadedGames[gameId] = {
          title: gameDetails.title,
          parts: [],
          downloadedDate: null
        };
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

      gamesToDownload++;

      await processGameInstallers({
        gameId,
        gameDetails,
        accessToken,
        platform,
        platformDownloadDir,
        platformDownloadedGames,
        config,
        savedPartNames,
        isOutdated
      });
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