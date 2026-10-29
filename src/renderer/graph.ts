// Lane layout for the commit graph and the per-row SVG rendering.
// Calm theme: lane 0 is muted, other lanes use the accent; HEAD node is filled.

export interface GraphNode {
  hash: string;
  parents: string[];
}

export interface GraphRow {
  hash: string;
  lane: number;
  before: (string | null)[];
  after: (string | null)[];
  mergeTo: number[];
}

export const LANE_W = 16;
export const ROW_H = 34;
const NODE_R = 4.5;
const PAD_L = 4; // left padding inside the svg so lane 0 does not touch the row edge

export function laneColor(lane: number): string {
  return lane === 0 ? 'var(--lane0)' : 'var(--accent)';
}

export function layoutGraph(nodes: GraphNode[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let maxLanes = 1;
  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const n of nodes) {
    const before = lanes.slice();
    let lane = lanes.indexOf(n.hash);
    if (lane === -1) lane = firstFree();
    for (let j = 0; j < lanes.length; j++) if (j !== lane && lanes[j] === n.hash) lanes[j] = null;
    const mergeTo: number[] = [];
    if (n.parents.length === 0) lanes[lane] = null;
    else {
      lanes[lane] = n.parents[0];
      for (const p of n.parents.slice(1)) {
        const k = lanes.indexOf(p);
        if (k !== -1 && k !== lane) mergeTo.push(k);
        else if (k === -1) lanes[firstFree()] = p;
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const after = lanes.slice();
    maxLanes = Math.max(maxLanes, before.length, after.length, lane + 1);
    rows.push({ hash: n.hash, lane, before, after, mergeTo });
  }
  return { rows, width: maxLanes };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const x = (lane: number) => PAD_L + lane * LANE_W + LANE_W / 2;

function curve(x1: number, y1: number, x2: number, y2: number, color: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  const ym = (y1 + y2) / 2;
  p.setAttribute('d', x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`);
  p.setAttribute('stroke', color);
  p.setAttribute('stroke-width', '1.5');
  p.setAttribute('fill', 'none');
  return p;
}

export function graphWidth(lanes: number): number {
  return PAD_L * 2 + Math.max(lanes, 1) * LANE_W;
}

export function renderRowSvg(row: GraphRow, width: number, opts: { working?: boolean; head?: boolean } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const w = graphWidth(width);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(ROW_H));
  svg.setAttribute('viewBox', `0 0 ${w} ${ROW_H}`);
  const mid = ROW_H / 2;
  const xc = x(row.lane);

  row.before.forEach((h, j) => {
    if (!h) return;
    svg.appendChild(h === row.hash ? curve(x(j), 0, xc, mid, laneColor(j)) : curve(x(j), 0, x(j), mid, laneColor(j)));
  });
  row.after.forEach((h, j) => {
    if (!h) return;
    svg.appendChild(row.before[j] === h ? curve(x(j), mid, x(j), ROW_H, laneColor(j)) : curve(xc, mid, x(j), ROW_H, laneColor(j)));
  });
  for (const k of row.mergeTo) svg.appendChild(curve(xc, mid, x(k), ROW_H, laneColor(k)));

  const node = document.createElementNS(SVG_NS, 'circle');
  node.setAttribute('cx', String(xc));
  node.setAttribute('cy', String(mid));
  node.setAttribute('r', String(NODE_R));
  node.setAttribute('stroke-width', '1.5');
  if (opts.working) {
    node.setAttribute('fill', 'var(--pane)');
    node.setAttribute('stroke', 'var(--muted)');
    node.setAttribute('stroke-dasharray', '3 2');
  } else if (opts.head) {
    node.setAttribute('fill', 'var(--accent)');
    node.setAttribute('stroke', 'var(--accent)');
  } else {
    node.setAttribute('fill', 'var(--pane)');
    node.setAttribute('stroke', laneColor(row.lane));
  }
  svg.appendChild(node);
  return svg;
}
