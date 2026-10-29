/** Git accepts timestamps beyond the range representable by JavaScript Date. */
export function gitCommitDate(timestamp: number) {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return { label: "Unknown date", detail: `Git timestamp: ${timestamp}`, dateTime: undefined };
  return { label: date.toLocaleDateString(), detail: date.toLocaleString(), dateTime: date.toISOString() };
}
