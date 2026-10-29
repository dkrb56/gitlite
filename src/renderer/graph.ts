// Lane layout for the commit graph and the per-row SVG rendering.

export interface GraphNode {
  hash: string;
  parents: string[];
}

export interface GraphRow {
  hash: string;
  lane: number;
  before: (string | null)[]; // lane contents entering this row
  after: (string | null)[]; // lane contents leaving this row
  mergeTo: number[]; // lanes (in `after`) of extra parents that already had a lane
}

export const LANE_W = 16;
export const ROW_H = 24;
const NODE_R = 4;

const PALETTE = ['#5b9cf6', '#58b36b', '#e8a33d', '#d96ac2', '#4fc3c7', '#e5604f', '#a98bf0', '#c8c45a'];

export function laneColor(lane: number): string {
  return PALETTE[lane % PALETTE.length];
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
    // Every other lane that was waiting for this commit ends here.
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] === n.hash) lanes[j] = null;
    }
    const mergeTo: number[] = [];
    if (n.parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = n.parents[0];
      for (const p of n.parents.slice(1)) {
        const k = lanes.indexOf(p);
        if (k !== -1 && k !== lane) {
          mergeTo.push(k);
        } else if (k === -1) {
          lanes[firstFree()] = p;
        }
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

function x(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}

function curve(x1: number, y1: number, x2: number, y2: number, color: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  const ym = (y1 + y2) / 2;
  const d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
  p.setAttribute('d', d);
  p.setAttribute('stroke', color);
  p.setAttribute('stroke-width', '2');
  p.setAttribute('fill', 'none');
  return p;
}

export function renderRowSvg(row: GraphRow, width: number, working: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const w = Math.max(width, 1) * LANE_W;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(ROW_H));
  svg.setAttribute('viewBox', `0 0 ${w} ${ROW_H}`);
  const mid = ROW_H / 2;
  const xc = x(row.lane);

  // Upper half: lanes coming in from the row above.
  row.before.forEach((h, j) => {
    if (!h) return;
    if (h === row.hash) svg.appendChild(curve(x(j), 0, xc, mid, laneColor(j)));
    else svg.appendChild(curve(x(j), 0, x(j), mid, laneColor(j)));
  });

  // Lower half: lanes leaving to the row below.
  row.after.forEach((h, j) => {
    if (!h) return;
    if (row.before[j] === h) svg.appendChild(curve(x(j), mid, x(j), ROW_H, laneColor(j)));
    else svg.appendChild(curve(xc, mid, x(j), ROW_H, laneColor(j)));
  });
  for (const k of row.mergeTo) svg.appendChild(curve(xc, mid, x(k), ROW_H, laneColor(k)));

  const node = document.createElementNS(SVG_NS, 'circle');
  node.setAttribute('cx', String(xc));
  node.setAttribute('cy', String(mid));
  node.setAttribute('r', String(NODE_R));
  const color = laneColor(row.lane);
  if (working) {
    node.setAttribute('fill', '#1e1f24');
    node.setAttribute('stroke', color);
    node.setAttribute('stroke-width', '2');
    node.setAttribute('stroke-dasharray', '2 2');
  } else {
    node.setAttribute('fill', color);
    node.setAttribute('stroke', '#1e1f24');
    node.setAttribute('stroke-width', '1.5');
  }
  svg.appendChild(node);
  return svg;
}
