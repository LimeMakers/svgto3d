// Author: Dean McNamee, November 2013

// SVG -> extruded extruded 3d obj.
// Reads in an SVG file, extracts the <path> objects, tries to apply any
// transforms (although this part is underdeveloped), and produces an obj file
// to standard output, positioned with the same coordinates as the original SVG
// file, and with the z coordinate 0 on one side and 1 on the other side.
// Tessellation (triangulation) is done via Eric Veach's GLU tessellator
// (libtess), in the future it would be worth looking into libtess2 which has a
// better interface and likely also better performance.

var fs = require('fs');
var libtess = require('./libtess.cat.js');
var omgsvg = require('./omgsvg.js');

// This is a bit tricky since our SVG works in some sort of pixel coordinates,
// but then we really want to think about the tolerance more in terms of mm,
// but that conversion happens later.  Here we specify roughly the number of
// pixels of error to allow, and we will continue to subdivide curves until
// the error from converting to lines is small enough.  This is additionally
// complicated by the fact that the path might be in another coordinate system
// (since transforms can be applied), so we have to try to apply that transform
// to the tolerance also, so that they share the same coordinate space...
var kCurveTolerance = 0.1;

if (process.argv.length !== 3) {
  console.log('Usage: <input.svg>');
  process.exit(1);
}

var kEpsilon    =  0.00000000001;
var kNegEpsilon = -0.00000000001;
function ep_eq(x, y) {  // Equality within 2*epsilon error.
  var d = x - y;
  return d <= kEpsilon && d >= kNegEpsilon;
}

function v_line(x, y, z) {
  var prec = 10;
  return 'v ' + x.toPrecision(prec)  + ' ' + y.toPrecision(prec) + ' ' +
                z.toPrecision(prec);
}

function f_line(x, y, z) {
  return 'f ' + x + ' ' + y + ' ' + z;
}

// Doesn't deal with intersections, only with duplicated vertices that create
// and "loop", basically meaning the same vertex appears twice.  Also make sure
// that the polygon isn't "double closed", meaning that the start point is not
// repeated at the end, since we want a polygon that is closed implicitly.
// Operators on |points| in place.  Returns number of loops removed.
function remove_loops_and_double_close(points) {
  var count = 0;
  retry: for(;;) {  // Easier than properly continuing after removing a loop.
    for (var k = 1, kl = points.length; k < kl; k += 2) {
      var x0 = points[k-1], y0 = points[k];
      for (var j = k+2; j < kl; j += 2) {
        var x1 = points[j-1], y1 = points[j];
        if (ep_eq(x0, x1) && ep_eq(y0, y1)) {
          if (k === 1 && j+1 === kl) {  // start and end points match.
            //console.log('Removing start/end point double up');
            points.splice(kl-2, 2);
          } else {
            if (j - k > 4)
              throw 'removed big loop: ' + JSON.stringify([j-k, j, k, points]);
            // console.log('Removing loop'); console.log([k, j, x0, y0]);
            //console.log(points);
            points.splice(k-1, j-k);
            //console.log(points);
            ++count;  // Count loops removed (but not start/end double up).
          }

          continue retry;  // Just keep repeating as long something was removed.
        }
      }
    }
    break;
  }

  return count;
}

function apply_transform(t, glyphs) {
  var a = t[0], b = t[1], c = t[2], d = t[3], e = t[4], f = t[5];
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0)
    return;  // Identity.

  // Apply the 3 x 3 matrix
  // x -> a*x + c*y + e;
  // y -> b*x + d*y + f;
  for (var i = 0, il = glyphs.length; i < il; ++i) {
    var contours = glyphs[i];
    for (var j = 0, jl = contours.length; j < jl; ++j) {
      var contour = contours[j];
      for (var k = 1, kl = contour.length; k < kl; k += 2) {
        var x = contour[k-1], y = contour[k];
        contour[k-1] = a*x + c*y + e;
        contour[k] = b*x + d*y + f;
      }
    }
  }
}

var data = fs.readFileSync(process.argv[2], 'utf8');
var out = fs.createWriteStream(process.argv[2].replace(/\.svg$/, '.obj'), {flags: 'w'})

var re_transform = /<g[^]+?transform="([^"]*)"/mgi;
var transform_string = null;
while ((res = re_transform.exec(data)) !== null) {
  if (transform_string !== null) throw 'Multiple transforms';
  transform_string = res[1];
}

if (transform_string === null) throw 'No transform';
// console.log(transform_string);

var transform_matrix = [1, 0, 0, 1, 0, 0];
omgsvg.applyTransformStringToMatrix(transform_matrix, transform_string);

var re_path_d = /<path[^]+?d="([^"]*)"/mgi;
var res;
var glyphs = [ ];
while ((res = re_path_d.exec(data)) !== null) {
  var contours = omgsvg.constructPolygonFromSVGPath(
      res[1], {tolerance: Math.min(kCurveTolerance / transform_matrix[0],
                                   kCurveTolerance / transform_matrix[3])});

  var c = 0;
  for (var j = 0, jl = contours.length; j < jl; ++j)
    c += remove_loops_and_double_close(contours[j]);
  if (c !== 0) console.log('# Removed ' + c + ' loops from: ' + res[1]);

  glyphs.push(contours);
}

apply_transform(transform_matrix, glyphs);

function vertexCallback(data, verts) {
  if (Array.isArray(data)) throw 'xxxx';
  verts.push(data);
}
function begincallback(type) {
  if (type !== libtess.primitiveType.GL_TRIANGLES)
    throw 'expected TRIANGLES but got type: ' + type;
}
function errorcallback(errno) {
  throw 'glu tess error number: ' + errno;
}

// callback for when segments intersect and must be split
function combinecallback(coords, data, weight) {
  console.trace('Currently cannot handle combines.');
  throw 'combine:' + JSON.stringify([coords, data, weight]);
}

function edgeCallback(flag) {
  //console.log('edge flag: ' + flag);
}


var tessy = new libtess.GluTesselator();
// tessy.gluTessProperty(libtess.gluEnum.GLU_TESS_WINDING_RULE, libtess.windingRule.GLU_TESS_WINDING_POSITIVE);
tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_VERTEX_DATA, vertexCallback);
tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_BEGIN, begincallback);
tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_ERROR, errorcallback);
tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_COMBINE, combinecallback);
tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_EDGE_FLAG, edgeCallback);
//tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_MESH, meshCallback);

tessy.gluTessNormal(0, 0, 1);

var triangles = [ ];

var edge_dict = { };  // Keep track of exterior edges.

// 1 - Tessellate and produce all of the vertices.  We produce two copies of
//     every vertex for both sides of the extrusion.
var vertex_c = 0;
for (var i = 0, il = glyphs.length; i < il; ++i) {
  var contours = glyphs[i];
  var verts = [ ];
  tessy.gluTessBeginPolygon(verts);
  for (var j = 0, jl = contours.length; j < jl; ++j) {
    var contour = contours[j];
    tessy.gluTessBeginContour();
    for (var k = 1, kl = contour.length; k < kl; k += 2) {
      var x = contour[k-1], y = contour[k];

      tessy.gluTessVertex([x, y, 0], vertex_c);
      // out.write('# vertex ' + vertex_c);  // Useful for debugging.
      out.write(v_line(x, y, 0) + '\n');
      out.write(v_line(x, y, 1) + '\n');

      var prev = (k === 1 ? vertex_c + (kl / 2) : vertex_c) - 1;
      // Store in both directions.  We don't care about the original SVG path
      // ordering (CCW vs CW), store both directions here so we don't need to
      // check twice in the triangle code.
      edge_dict[prev + ',' + vertex_c] = true;
      edge_dict[vertex_c + ',' + prev] = true;

      ++vertex_c;
    }
    tessy.gluTessEndContour();
  }
  tessy.gluTessEndPolygon();
  triangles.push(verts);
}

// 2 - Produce the triangles for faces of the extrusion, and connecting sides.
//     This is a bit tricky, I don't believe we can rely on the order of the
//     original SVG path (CW, CCW, holes, etc).  Instead we should just be able
//     to rely on the triangulation.  For each triangle we check if any of its
//     edges are an edge in the original loop (stored in |edge_dict| as
//     populated above), which means it is not an interior edge.  We can base
//     the extrusion side on the direction of the triangle, to get the ordering
//     right for inside vs outside (holes) surfaces.
function emit_side_quad(i0, i1) {  // Expects i0 and i1 in CCW order.
  out.write(f_line(i0, i0+1, i1) + '\n');
  out.write(f_line(i1, i0+1, i1+1) + '\n');
}

for (var i = 0, il = triangles.length; i < il; ++i) {
  var verts = triangles[i];
  if (verts.length % 3 !== 0) throw 'xx';
  for (var j = 2, jl = verts.length; j < jl; j += 3) {
    var i0 = verts[j-2], i1 = verts[j-1], i2 = verts[j];

    // Awkward because obj numbering starts from 1 and not 0...
    out.write(f_line(i2*2+1, i1*2+1, i0*2+1) + '\n');
    out.write(f_line(i0*2+2, i1*2+2, i2*2+2) + '\n');

    // Attach the two faces of the extrusion along all exterior edges.
    if (edge_dict[i2+','+i1] === true) emit_side_quad(i2*2+1, i1*2+1);
    if (edge_dict[i1+','+i0] === true) emit_side_quad(i1*2+1, i0*2+1);
    if (edge_dict[i0+','+i2] === true) emit_side_quad(i0*2+1, i2*2+1);
  }
}
