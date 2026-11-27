/* что здесь живёт: выбор поверхности под курсором. Модель и сплаты используют одни
 * и те же треугольники исходной геометрии, включая вертикальные грани и навесы. */
import { TILESET, flattenTileset } from './config.js?v=33';

const C = Cesium, V = C.Cartesian3, M = C.Matrix4;
let index;
const tiles = new Map();

async function response(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Не удалось загрузить геометрию поверхности (' + res.status + ')');
  return res;
}

async function loadIndex() {
  const url = new URL(TILESET, document.baseURI);
  const data = await (await response(url)).json();
  const frame = {};
  flattenTileset(frame);
  const leaves = [];
  function visit(tile, parent) {
    const world = tile.transform ? M.multiply(parent, M.fromArray(tile.transform), new M()) : parent;
    if (tile.children?.length) {
      for (const child of tile.children) visit(child, world);
      return;
    }
    if (!tile.content) return;
    const b = (tile.content.boundingVolume || tile.boundingVolume).box;
    const half = [0,1,2].map(i=>Math.abs(b[i+3])+Math.abs(b[i+6])+Math.abs(b[i+9]));
    const model = M.multiply(world, C.Axis.Y_UP_TO_Z_UP, new M());
    leaves.push({url:new URL(tile.content.uri,url).href,
      low:b.slice(0,3).map((v,i)=>v-half[i]-.001), high:b.slice(0,3).map((v,i)=>v+half[i]+.001),
      tileInverse:M.inverseTransformation(world,new M()), model, inverse:M.inverseTransformation(model,new M())});
  }
  visit(data.root, frame.modelMatrix);
  return leaves;
}

// This map's GLBs contain indexed triangles, plain float positions and mesh-only nodes.
async function loadMesh(url) {
  const buffer=await (await response(url)).arrayBuffer(), header=new DataView(buffer);
  const jsonLength=header.getUint32(12,true), bin=28+jsonLength;
  const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,jsonLength)));
  function attribute(index,Type,size) {
    const a=doc.accessors[index], view=doc.bufferViews[a.bufferView];
    // Keep collision coordinates and indices in cache, release the texture payload.
    return new Type(buffer,bin+(view.byteOffset||0)+(a.byteOffset||0),a.count*size).slice();
  }
  return doc.meshes.flatMap(m=>m.primitives.map(p=>({
    xyz:attribute(p.attributes.POSITION,Float32Array,3),
    indices:attribute(p.indices,doc.accessors[p.indices].componentType===5125?Uint32Array:Uint16Array,1)
  })));
}
function localRay(ray,inverse) {
  return new C.Ray(M.multiplyByPoint(inverse,ray.origin,new V()),
    M.multiplyByPointAsVector(inverse,ray.direction,new V()));
}
function boxEntry(ray,tile) {
  const local=localRay(ray,tile.tileInverse);
  let near=0, far=Infinity;
  for(const [i,k] of ['x','y','z'].entries()) {
    const o=local.origin[k], d=local.direction[k];
    if(Math.abs(d)<1e-10) {
      if(o<tile.low[i] || o>tile.high[i]) return Infinity;
    } else {
      const a=(tile.low[i]-o)/d,b=(tile.high[i]-o)/d;
      near=Math.max(near,Math.min(a,b)); far=Math.min(far,Math.max(a,b));
      if(near>far) return Infinity;
    }
  }
  return near;
}
export async function meshSurface(ray) {
  index ??= loadIndex().catch(e=>{index=null; throw e;});
  const candidates=(await index).map(tile=>({tile,entry:boxEntry(ray,tile)}))
    .filter(c=>Number.isFinite(c.entry)).sort((a,b)=>a.entry-b.entry);
  let best=Infinity, normal=null;
  const a=new V(), b=new V(), c=new V();
  for(const {tile,entry} of candidates) {
    if(entry>best) break;
    if(!tiles.has(tile.url))
      tiles.set(tile.url,loadMesh(tile.url).catch(e=>{tiles.delete(tile.url); throw e;}));
    const local=localRay(ray,tile.inverse);
    for(const {xyz,indices} of await tiles.get(tile.url)) {
      for(let i=0;i<indices.length;i+=3) {
        V.fromArray(xyz,indices[i]*3,a); V.fromArray(xyz,indices[i+1]*3,b); V.fromArray(xyz,indices[i+2]*3,c);
        const t=C.IntersectionTests.rayTriangleParametric(local,a,b,c,false);
        if(t===undefined || t<=0 || t>=best) continue;
        best=t;
        const n=V.cross(V.subtract(b,a,b),V.subtract(c,a,c),new V());
        normal=V.normalize(M.multiplyByPointAsVector(tile.model,n,n),n);
        if(V.dot(normal,ray.direction)>0) V.negate(normal,normal);
      }
    }
  }
  return normal ? {position:C.Ray.getPoint(ray,best,new V()),normal} : null;
}
