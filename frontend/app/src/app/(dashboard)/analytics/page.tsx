import { AnalyticsView } from "@/components/analytics/analytics-view";

/**
 * Read-only analytics route for the published cohort in the active Brand
 * Profile scope. The view owns URL state, queries, coverage, and freshness.
 *
 * @returns React element rendering the analytics view.
 */
export default function AnalyticsPage(): React.ReactElement {
  return <AnalyticsView />;
}
