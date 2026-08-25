import {numberValue, shortText} from "./insights-format.js?v=1";

export async function fetchYouTubeJson(url, accessToken) {
  const response = await fetch(url, {headers: {Authorization: `Bearer ${accessToken}`}});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "YouTube API request failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchUploadsPlaylistId(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchYouTubeJson(url, accessToken);
  const playlistId = payload.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("No uploads playlist was found for your linked channel.");
  return playlistId;
}

export async function fetchChannelProfile(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,brandingSettings,topicDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchYouTubeJson(url, accessToken);
  const channel = payload.items?.[0];
  if (!channel) return null;
  return {
    id: channel.id || "",
    title: channel.snippet?.title || "",
    description: shortText(channel.snippet?.description || "", 700),
    customUrl: channel.snippet?.customUrl || "",
    country: channel.snippet?.country || "",
    keywords: shortText(channel.brandingSettings?.channel?.keywords || "", 500),
    subscriberCount: numberValue(channel.statistics?.subscriberCount) || 0,
    videoCount: numberValue(channel.statistics?.videoCount) || 0,
    viewCount: numberValue(channel.statistics?.viewCount) || 0,
    topicCategories: channel.topicDetails?.topicCategories || []
  };
}

async function fetchUploadVideoIds(accessToken) {
  const playlistId = await fetchUploadsPlaylistId(accessToken);
  const ids = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await fetchYouTubeJson(url, accessToken);
    payload.items?.forEach((item) => {
      if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
    });
    pageToken = payload.nextPageToken || "";
  } while (pageToken && ids.length < 200);
  return ids;
}

export async function fetchVideosByIds(videoIds, accessToken) {
  const videos = [];
  for (let index = 0; index < videoIds.length; index += 50) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", videoIds.slice(index, index + 50).join(","));
    const payload = await fetchYouTubeJson(url, accessToken);
    videos.push(...(payload.items || []));
  }
  return videos;
}

export async function fetchChannelVideos(accessToken) {
  const videoIds = await fetchUploadVideoIds(accessToken);
  return videoIds.length ? fetchVideosByIds(videoIds, accessToken) : [];
}
