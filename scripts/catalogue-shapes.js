'use strict';
/**
 * One definition of "the same port shape".
 *
 * Two things count port shapes: `test/faceplate-catalogue.test.js`, which sweeps every model and prints
 * how many distinct shapes the renderer covered, and `scripts/regen-registry-doc.js`, which writes that
 * printed line into `docs/CONNECTORS.md`. Those were two copies of the same expression, and the page
 * went stale against the test the moment a device landed - the number a reader saw was not the number
 * the suite printed. So the rule lives here, once, and both callers require it.
 *
 * A shape is what the faceplate draws alike: the category, the port template if there is one, and the
 * ordered list of connector/type pairs on explicit ports. Names and speeds are deliberately out - a
 * 24-port and a 48-port switch of the same family are one shape, which is what "distinct port shapes"
 * is meant to count.
 */
function shapeOf(spec) {
  const ifs = spec.interfaces || [];
  return (spec.category || '?') + '|' +
    (spec.portTemplate ? 'template:' + JSON.stringify(spec.portTemplate) : '') + '|' +
    ifs.map(function (i) { return i.connector + '/' + i.type; }).join(',');
}

module.exports = { shapeOf };
