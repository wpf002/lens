import { execFile } from "child_process";

export function convertToPdf(source: string) {
  return execFile("wkhtmltopdf", [source, "/tmp/report.pdf"]);
}

export function tarReport(reportId: number) {
  return execFile("tar", ["czf", `/tmp/report-${reportId}.tgz`, "/var/reports"]);
}
