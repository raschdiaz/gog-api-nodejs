import fs from 'fs';
import path from 'path';

export const CONFIG_FILE = './config.json';

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(configData) {
  const currentConfig = loadConfig();
  const newConfig = { ...currentConfig, ...configData };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
}

export function loadStoredTokens() {
  return loadConfig().tokens || null;
}

export function saveTokens(tokenData) {
  saveConfig({
    tokens: {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in || 3600,
      saved_at: Date.now()
    }
  });
  console.log(`[Auth] Saved updated tokens to ${CONFIG_FILE}`);
}

export function normalizeDownloadedGameState(gameId, value, fallbackTitle = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      title: typeof value === 'string' ? value : fallbackTitle || String(gameId),
      parts: [],
      downloadedDate: null
    };
  }

  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title
    : fallbackTitle || String(gameId);

  const rawParts = Array.isArray(value.parts) ? value.parts : [];
  const uniqueParts = [...new Set(rawParts
    .filter(part => typeof part === 'string' && part.trim())
    .map(part => part.trim()))];
  const partNames = new Set(uniqueParts.map(part => part.toLowerCase()));
  const parts = uniqueParts.filter(part => {
    return path.extname(part) || !partNames.has(`${part}.exe`.toLowerCase());
  });

  const downloadedDate = typeof value.downloadedDate === 'string'
    && !Number.isNaN(Date.parse(value.downloadedDate))
    ? value.downloadedDate
    : null;

  return { title, parts, downloadedDate };
}

export function normalizeAllDownloadedGames(downloadedGames) {
  if (!downloadedGames || typeof downloadedGames !== 'object') return {};

  const normalized = {};
  for (const [platform, platformGames] of Object.entries(downloadedGames)) {
    normalized[platform] = {};
    if (!platformGames || typeof platformGames !== 'object' || Array.isArray(platformGames)) {
      continue;
    }

    for (const [gameId, gameValue] of Object.entries(platformGames)) {
      normalized[platform][gameId] = normalizeDownloadedGameState(
        gameId,
        gameValue,
        'Unknown Title (migrated)'
      );
    }
  }
  return normalized;
}

export function getLatestInstallerModifiedDate(installers) {
  const timestamps = installers
    .map(installer => installer.modifiedDate)
    .filter(date => typeof date === 'string' && !Number.isNaN(Date.parse(date)))
    .map(date => Date.parse(date));

  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
}

export function savePlatformGameState(config, platform, platformDownloadedGames) {
  saveConfig({
    downloadedGames: {
      ...(config.downloadedGames || {}),
      [platform]: platformDownloadedGames
    }
  });
}
