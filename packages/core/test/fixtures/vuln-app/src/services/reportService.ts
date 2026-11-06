import { queryReport } from "../db/reportQueries";
import { convertToPdf, tarReport } from "../lib/shell";

export async function loadReport(reportId: string) {
  const key = reportId.trim();
  return queryReport(key);
}

export async function renderReport(title: string) {
  return convertToPdf(`${title}.html`);
}

export async function archiveReport(reportId: number) {
  return tarReport(reportId);
}
