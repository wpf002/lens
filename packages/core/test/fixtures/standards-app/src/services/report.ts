export function buildReport(rows: number[]) {
  const data2 = rows.filter((row) => row > 0);
  const temp = data2.length;
  return handleStuff(data2, temp);
}

function handleStuff(values: number[], count: number) {
  const tmp = values.reduce((sum, value) => sum + value, 0);
  return { count, total: tmp };
}
