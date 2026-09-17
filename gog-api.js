import path from 'path';

const EMBED_BASE_URL = 'https://embed.gog.com';
const USERS_BASE_URL = 'https://users.gog.com';
const TARGET_LANGUAGE = 'English';

export function getHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  };
}

export async function fetchOwnedGames(accessToken) {
  const res = await fetch(`${EMBED_BASE_URL}/user/data/games`, {
    headers: getHeaders(accessToken)
  });
  if (!res.ok) throw new Error(`Library fetch failed: ${res.statusText}`);
  const data = await res.json();
  return data.owned;
}

export async function getGameDetails(gameId, accessToken, targetPlatform) {
  const res = await fetch(`${EMBED_BASE_URL}/account/gameDetails/${gameId}.json`, {
    headers: getHeaders(accessToken)
  });
  if (!res.ok) return null;

  const data = await res.json();
  const installers = [];
  const gameTags = Array.isArray(data.tags)
    ? data.tags.map(tag => tag.name)
    : [];

  for (const group of data.downloads || []) {
    const languageName = group[0];
    if (languageName?.toLowerCase() !== TARGET_LANGUAGE.toLowerCase()) continue;

    const platformFiles = group[1]?.[targetPlatform];
    if (!Array.isArray(platformFiles)) continue;

    for (const file of platformFiles) {
      installers.push({
        gameTitle: data.title,
        name: file.name,
        manualUrl: file.manualUrl,
        size: file.size,
        modifiedDate: file.modifiedDate || file.modified_date || file.updatedAt || null
      });
    }
  }

  return { title: data.title, tags: gameTags, installers };
}

export async function fetchAvailableTags(accessToken) {
  const res = await fetch(`${USERS_BASE_URL}/v1/tags`, {
    headers: getHeaders(accessToken)
  });
  if (!res.ok) {
    console.warn(`\n[Tags] Could not fetch available tags: ${res.statusText}.`);
    return [];
  }

  const tagsData = await res.json();
  return Array.isArray(tagsData) ? tagsData.map(tag => tag.name) : [];
}

export async function getPredictedFilename(item, accessToken, targetPlatform) {
  let predictedName = item.name;

  try {
    const res = await fetch(`${EMBED_BASE_URL}${item.manualUrl}`, {
      method: 'HEAD',
      headers: getHeaders(accessToken),
      redirect: 'follow'
    });

    const contentDisposition = res.headers.get('content-disposition');
    const dispositionMatch = contentDisposition?.match(
      /filename\*=UTF-8''([^;]+)|filename=['"]?([^;'\"]+)['"]?/i
    );
    const dispositionName = dispositionMatch?.[1] || dispositionMatch?.[2];
    if (dispositionName) {
      try {
        predictedName = decodeURIComponent(dispositionName);
      } catch {
        predictedName = dispositionName;
      }
    } else if (res.ok) {
      const urlName = path.basename(new URL(res.url).pathname);
      if (urlName) predictedName = urlName;
    }
  } catch {
    // Use the API name when the filename lookup fails.
  }

  if (!path.extname(predictedName) && targetPlatform === 'windows') {
    predictedName += '.exe';
  }

  return predictedName.replace(/[/\\?%*:|"<>]/g, '_');
}
