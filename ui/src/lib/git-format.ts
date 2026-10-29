/** Git accepts timestamps beyond the range representable by JavaScript Date. */
export function gitCommitDate(timestamp: number) {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return { label: "Unknown date", detail: `Git timestamp: ${timestamp}`, dateTime: undefined };
  return { label: date.toLocaleDateString(), detail: date.toLocaleString(), dateTime: date.toISOString() };
}

/** Graph edges are derived only from the loaded commits and their actual parent IDs. */
export function gitCommitGraph(commits: readonly { id: string; parents: string[] }[]) {
  let lanes: string[] = [];
  return commits.map(commit => {
    let lane = lanes.indexOf(commit.id);
    if (lane < 0) { lane = lanes.length; lanes = [...lanes, commit.id]; }
    const before = [...lanes];
    const after = [...lanes]; after.splice(lane, 1);
    commit.parents.forEach((parent, index) => {
      if (!after.includes(parent)) after.splice(Math.min(lane + index, after.length), 0, parent);
    });
    const x = (column: number) => 8 + column * 10;
    const edges: { path: string; lane: number }[] = [];
    before.forEach((id, column) => {
      if (id === commit.id) edges.push({ path: `M${x(column)} 0V18`, lane: column });
      else {
        const target = after.indexOf(id);
        if (target >= 0) edges.push({ path: `M${x(column)} 0C${x(column)} 18 ${x(target)} 18 ${x(target)} 38`, lane: column });
      }
    });
    commit.parents.forEach(parent => { const target = after.indexOf(parent); edges.push({ path: `M${x(lane)} 18C${x(lane)} 29 ${x(target)} 27 ${x(target)} 38`, lane }); });
    lanes = after;
    return { lane, x: x(lane), width: Math.max(18, x(Math.max(before.length, after.length) - 1) + 8), edges };
  });
}
