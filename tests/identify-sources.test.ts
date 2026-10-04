import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DOMParser } from "linkedom";
import {
  fetchWmsIdentifyProperties,
  isPixelIdentifyLayer,
  pixelIdentifyProperties,
  setWmsIdentifyProjectionResolver,
} from "../packages/map/src/identify-sources";
import { GEOGRAPHIC_WMS_CRS } from "../apps/geolibre-desktop/src/lib/wms-geographic";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Engine-neutral identify sources shared by the MapLibre and Mapbox canvases
// (#2475): WMS GetFeatureInfo needs only the clicked lngLat and the zoom.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const wmsLayer = (source: Record<string, unknown> = {}) =>
  geojsonLayer({
    id: "wms",
    type: "wms",
    geojson: undefined,
    source: { type: "raster", url: "https://wms.example/service", layers: "roads", ...source },
  });

function stubFetch(body: string, contentType: string) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return urls;
}

describe("fetchWmsIdentifyProperties", () => {
  it("queries a box centered on the click, sized by the zoom", async () => {
    const urls = stubFetch(
      JSON.stringify({ type: "FeatureCollection", features: [{ id: 7, properties: { a: 1 } }] }),
      "application/json",
    );
    const result = await fetchWmsIdentifyProperties(
      wmsLayer({ infoFormat: "application/json" }),
      [0, 0],
      10,
      new AbortController().signal,
    );
    assert.deepEqual(result, { featureId: 7, properties: { a: 1 } });
    const url = new URL(urls[0], "http://localhost");
    const inner = url.searchParams.get("url") ? new URL(url.searchParams.get("url")!) : url;
    assert.equal(inner.searchParams.get("REQUEST"), "GetFeatureInfo");
    const [minX, minY, maxX, maxY] = inner.searchParams.get("BBOX")!.split(",").map(Number);
    assert.ok(Math.abs(minX + maxX) < 1e-6 && Math.abs(minY + maxY) < 1e-6);
    // 101 px at zoom 10 of 512-px tiles.
    const span = maxX - minX;
    const expected = (101 * (2 * Math.PI * 6378137)) / (512 * 2 ** 10);
    assert.ok(Math.abs(span - expected) < 1e-6);
  });

  it("falls back to the text of an HTML response", async () => {
    stubFetch("<html><body><p>Road  42</p></body></html>", "text/html");
    const original = globalThis.DOMParser;
    globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
    try {
      const result = await fetchWmsIdentifyProperties(
        wmsLayer({ infoFormat: "text/html" }),
        [10, 20],
        4,
        new AbortController().signal,
      );
      assert.deepEqual(result, { properties: { result: "Road 42" } });
    } finally {
      globalThis.DOMParser = original;
    }
  });
});

// A WMS drawn in its own CRS (#2562, #2695) rejects GetFeatureInfo in
// EPSG:3857 just as it rejects GetMap, so identify follows `source.crs` (#2886).
describe("fetchWmsIdentifyProperties in the layer's CRS", () => {
  afterEach(() => setWmsIdentifyProjectionResolver(null));

  async function identifyQuery(source: Record<string, unknown>, lngLat: [number, number]) {
    const urls = stubFetch("Feature 1", "text/plain");
    await fetchWmsIdentifyProperties(
      wmsLayer({ infoFormat: "text/plain", ...source }),
      lngLat,
      16,
      new AbortController().signal,
    );
    const url = new URL(urls[0], "http://localhost");
    const inner = url.searchParams.get("url") ? new URL(url.searchParams.get("url")!) : url;
    return {
      params: inner.searchParams,
      bbox: inner.searchParams.get("BBOX")!.split(",").map(Number),
    };
  }

  const center = ([a, b, c, d]: number[]) => [(a + c) / 2, (b + d) / 2];
  const near = (actual: number[], expected: number[]) =>
    actual.every((value, index) => Math.abs(value - expected[index]) < 1e-9);

  it("asks a geographic CRS latitude first in WMS 1.3.0, centered on the click", async () => {
    const { params, bbox } = await identifyQuery(
      { version: "1.3.0", crs: "EPSG:6706" },
      [12.5973, 42.2979],
    );
    assert.equal(params.get("CRS"), "EPSG:6706");
    assert.ok(near(center(bbox), [42.2979, 12.5973]), bbox.join(","));
    assert.equal(params.get("I"), "50");
    assert.equal(params.get("J"), "50");
    // About the ground of the 101 px Web Mercator box at zoom 16: tens of metres.
    assert.ok(bbox[3] - bbox[1] > 0.0002 && bbox[3] - bbox[1] < 0.002);
  });

  it("keeps longitude first for CRS:84 and for WMS 1.1.1", async () => {
    const crs84 = await identifyQuery({ version: "1.3.0", crs: "CRS:84" }, [12.5973, 42.2979]);
    assert.equal(crs84.params.get("CRS"), "CRS:84");
    assert.ok(near(center(crs84.bbox), [12.5973, 42.2979]));
    const v111 = await identifyQuery({ version: "1.1.1", crs: "EPSG:4258" }, [12.5973, 42.2979]);
    assert.equal(v111.params.get("SRS"), "EPSG:4258");
    assert.ok(near(center(v111.bbox), [12.5973, 42.2979]));
  });

  it("asks every geographic CRS the desktop draws in that CRS", async () => {
    for (const crs of GEOGRAPHIC_WMS_CRS) {
      const { params } = await identifyQuery({ version: "1.3.0", crs }, [12, 42]);
      assert.equal(params.get("CRS"), crs);
    }
  });

  it("projects the click into a projected CRS through the installed resolver", async () => {
    const asked: string[] = [];
    // A stand-in projection: metres east/north of the click, easting first.
    setWmsIdentifyProjectionResolver(async (crs) => {
      asked.push(crs);
      return { forward: ([lng, lat]) => [lng * 100000, lat * 100000], northFirst: false };
    });
    const { params, bbox } = await identifyQuery(
      { version: "1.3.0", crs: "epsg:25833" },
      [12.5973, 42.2979],
    );
    assert.deepEqual(asked, ["EPSG:25833"]);
    assert.equal(params.get("CRS"), "EPSG:25833");
    assert.ok(near(center(bbox), [1259730, 4229790]), bbox.join(","));
  });

  it("writes a north-first projected CRS northing first in WMS 1.3.0", async () => {
    setWmsIdentifyProjectionResolver(async () => ({
      forward: ([lng, lat]) => [lng * 100000, lat * 100000],
      northFirst: true,
    }));
    const { bbox } = await identifyQuery({ version: "1.3.0", crs: "EPSG:3003" }, [12.5, 42.5]);
    assert.ok(near(center(bbox), [4250000, 1250000]), bbox.join(","));
  });

  it("reads the CRS from the tile template when source.crs is missing", async () => {
    // Python's wms_layer writes the CRS only into the GetMap template.
    const template =
      "https://wms.example/service?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=roads" +
      "&CRS=EPSG:6706&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256";
    const plain = await identifyQuery({ version: "1.3.0", tiles: [template] }, [12.5, 42.5]);
    assert.equal(plain.params.get("CRS"), "EPSG:6706");
    assert.ok(near(center(plain.bbox), [42.5, 12.5]));
    // The desktop routes the same template through its native tile protocol.
    const wrapped = `geolibre-wms://tile?url=${encodeURIComponent(template).replaceAll(
      "%7Bbbox-epsg-3857%7D",
      "{bbox-epsg-3857}",
    )}`;
    const native = await identifyQuery(
      { version: "1.1.1", tiles: [wrapped.replace("VERSION%3D1.3.0", "VERSION%3D1.1.1")] },
      [12.5, 42.5],
    );
    assert.equal(native.params.get("SRS"), "EPSG:6706");
    assert.ok(near(center(native.bbox), [12.5, 42.5]));
  });

  it("stays in EPSG:3857 without a CRS or with one it cannot resolve", async () => {
    const none = await identifyQuery({ version: "1.3.0" }, [12.5, 42.5]);
    assert.equal(none.params.get("CRS"), "EPSG:3857");
    const unresolved = await identifyQuery({ version: "1.3.0", crs: "EPSG:25833" }, [12.5, 42.5]);
    assert.equal(unresolved.params.get("CRS"), "EPSG:3857");
    setWmsIdentifyProjectionResolver(async () => null);
    const unknown = await identifyQuery({ version: "1.3.0", crs: "EPSG:99999" }, [12.5, 42.5]);
    assert.equal(unknown.params.get("CRS"), "EPSG:3857");
    setWmsIdentifyProjectionResolver(async () => {
      throw new Error("unparsable proj4 definition");
    });
    const failing = await identifyQuery({ version: "1.3.0", crs: "EPSG:25833" }, [12.5, 42.5]);
    assert.equal(failing.params.get("CRS"), "EPSG:3857");
  });
});

describe("pixel identify helpers", () => {
  it("flags Time Slider pixel layers and formats their band rows", () => {
    assert.equal(isPixelIdentifyLayer(geojsonLayer({ metadata: { pixelIdentify: true } })), true);
    assert.equal(isPixelIdentifyLayer(geojsonLayer()), false);
    const rows = pixelIdentifyProperties({
      sourceId: "s",
      date: "2026-01-01",
      url: "https://x",
      bands: [
        { index: 1, name: "red", value: 12, isNodata: false },
        { index: 2, name: null, value: 0, isNodata: true },
      ],
    });
    assert.equal(rows.Date, "2026-01-01");
    assert.equal(rows.red, "12");
    assert.match(String(rows["Band 2"]), /nodata/);
  });
});
