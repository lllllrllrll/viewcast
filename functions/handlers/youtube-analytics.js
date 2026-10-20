const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {requireVerifiedAuth} = require("../lib/callable-auth");
const {
  firstPrivateReport,
  googleOAuthClientSecret,
  privateYouTubeCredential,
} = require("../lib/youtube-auth");

const enforceAppCheck = true;

exports.getPrivateYouTubeVideoAnalytics = onCall(
    {
      secrets: [googleOAuthClientSecret],
      enforceAppCheck,
      region: "us-central1",
      timeoutSeconds: 30,
    },
    async (request) => {
      requireVerifiedAuth(
          request,
          "Sign in before loading private YouTube analytics.",
      );
      const videoId = String(request.data && request.data.videoId || "");
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        throw new HttpsError("invalid-argument", "Invalid YouTube video ID.");
      }

      const credential = await privateYouTubeCredential(request.auth.uid);
      const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      detailsUrl.searchParams.set("part", "snippet");
      detailsUrl.searchParams.set("id", videoId);
      const detailsResponse = await fetch(detailsUrl, {
        headers: {Authorization: `Bearer ${credential.accessToken}`},
      });
      const details = await detailsResponse.json().catch(() => ({}));
      const selectedVideo = details.items && details.items[0];
      if (!detailsResponse.ok || !selectedVideo ||
          selectedVideo.snippet.channelId !== credential.channelId) {
        throw new HttpsError(
            "permission-denied",
            "This video does not belong to the linked YouTube channel.",
        );
      }

      const baseReportUrl = (startDate, endDate) => {
        const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
        url.searchParams.set("ids", "channel==MINE");
        url.searchParams.set("startDate", startDate);
        url.searchParams.set("endDate", endDate);
        url.searchParams.set("filters", `video==${videoId}`);
        return url;
      };
      const [summaryRequest, retentionRequest, searchRequest] =
        await Promise.allSettled([
          firstPrivateReport(credential.accessToken, (startDate, endDate) => {
            const url = baseReportUrl(startDate, endDate);
            url.searchParams.set(
                "metrics",
                "views,estimatedMinutesWatched," +
                "averageViewDuration,averageViewPercentage",
            );
            return url;
          }),
          firstPrivateReport(credential.accessToken, (startDate, endDate) => {
            const url = baseReportUrl(startDate, endDate);
            url.searchParams.set("metrics", "audienceWatchRatio");
            url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
            return url;
          }),
          firstPrivateReport(credential.accessToken, (startDate, endDate) => {
            const url = baseReportUrl(startDate, endDate);
            url.searchParams.set("metrics", "views");
            url.searchParams.set("dimensions", "insightTrafficSourceDetail");
            url.searchParams.set(
                "filters",
                `video==${videoId};insightTrafficSourceType==YT_SEARCH`,
            );
            url.searchParams.set("sort", "-views");
            url.searchParams.set("maxResults", "3");
            return url;
          }),
        ]);

      if (retentionRequest.status === "rejected") {
        throw retentionRequest.reason;
      }
      const summaryResult = summaryRequest.status === "fulfilled" ?
        summaryRequest.value :
        {report: {rows: []}, label: "Lifetime"};
      const retentionResult = retentionRequest.value;
      const searchResult = searchRequest.status === "fulfilled" ?
        searchRequest.value :
        {report: {rows: []}, label: "Lifetime"};

      const summaryRow = summaryResult.report.rows &&
        summaryResult.report.rows[0];
      return {
        analytics: summaryRow ? {
          periodLabel: summaryResult.label,
          views: Number(summaryRow[0]) || 0,
          estimatedMinutesWatched: Number(summaryRow[1]) || 0,
          averageViewDuration: Number(summaryRow[2]) || 0,
          averageViewPercentage: Number(summaryRow[3]) || 0,
        } : null,
        retentionPoints: (retentionResult.report.rows || []).map((row) => ({
          position: Number(row[0]),
          ratio: Number(row[1]),
        })).filter((point) => Number.isFinite(point.position) &&
          Number.isFinite(point.ratio)),
        searchTerms: (searchResult.report.rows || []).map((row) => ({
          term: String(row[0] || "Unknown search term"),
          views: Number(row[1]) || 0,
          periodLabel: searchResult.label,
        })),
      };
    },
);
