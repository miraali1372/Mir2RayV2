export function progressPercent(completed: number, total: number) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }

  const percent = Math.floor((completed / total) * 100);
  return Math.max(0, Math.min(100, percent));
}
