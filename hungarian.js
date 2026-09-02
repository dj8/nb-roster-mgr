/* ============================================================
   Kuhn-Munkres (Hungarian) algorithm — exact O(n^3) minimum-cost
   bipartite assignment on a square cost matrix.
   Pure, no DOM/app state. Loaded before solver.js.
   ============================================================ */
(function(root){
"use strict";

/* Classic shortest-augmenting-path formulation (1-indexed internally).
   costMatrix: array of n arrays of n numbers (use a large finite sentinel,
   not Infinity, for "disqualified" cells — true Infinity would poison the
   potential arithmetic below).
   Returns: array `assignment` of length n where assignment[row] = col. */
function solve(costMatrix){
  const n = costMatrix.length;
  if(n===0) return [];
  costMatrix.forEach(row=>{
    if(row.length!==n) throw new Error("Hungarian.solve requires a square cost matrix");
  });

  const INF = Infinity;
  const u = new Array(n+1).fill(0);
  const v = new Array(n+1).fill(0);
  const p = new Array(n+1).fill(0);   // p[j] = row currently matched to column j (1-indexed row, 0 = unmatched)
  const way = new Array(n+1).fill(0);

  for(let i=1;i<=n;i++){
    p[0]=i;
    let j0=0;
    const minv = new Array(n+1).fill(INF);
    const used = new Array(n+1).fill(false);
    do{
      used[j0]=true;
      const i0=p[j0];
      let delta=INF, j1=-1;
      for(let j=1;j<=n;j++){
        if(!used[j]){
          const cur = costMatrix[i0-1][j-1]-u[i0]-v[j];
          if(cur<minv[j]){ minv[j]=cur; way[j]=j0; }
          if(minv[j]<delta){ delta=minv[j]; j1=j; }
        }
      }
      for(let j=0;j<=n;j++){
        if(used[j]){ u[p[j]]+=delta; v[j]-=delta; }
        else { minv[j]-=delta; }
      }
      j0=j1;
    } while(p[j0]!==0);
    do{
      const j1=way[j0];
      p[j0]=p[j1];
      j0=j1;
    } while(j0!==0);
  }

  const assignment = new Array(n).fill(-1);
  for(let j=1;j<=n;j++){
    if(p[j]>0) assignment[p[j]-1]=j-1;
  }
  return assignment;
}

const Hungarian = { solve };
if(typeof module!=="undefined" && module.exports){ module.exports = Hungarian; }
if(root) root.Hungarian = Hungarian;

})(typeof window!=="undefined" ? window : (typeof global!=="undefined" ? global : this));
