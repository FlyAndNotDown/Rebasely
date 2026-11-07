import { installAnalyticsBridge } from "./analytics-bridge";
import { createGoogleAnalyticsTag } from "./analytics-tag";

installAnalyticsBridge(window, (init) => createGoogleAnalyticsTag(window, import.meta.env.VITE_GA_APP_MEASUREMENT_ID, init));
