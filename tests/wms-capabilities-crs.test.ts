import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import {
  defaultWmsCrs,
  parseWmsCapabilities,
  wmsCrsChoices,
  wmsLayersAdvertiseCrs,
} from "../apps/geolibre-desktop/src/components/layout/add-data/helpers";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

// A 1.3.0 document where the root layer's CRS list is inherited by its
// children, and one child adds a CRS of its own.
const CAPABILITIES_130 = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Capability>
    <Layer>
      <Title>Root</Title>
      <CRS>EPSG:4326</CRS>
      <CRS>EPSG:25832</CRS>
      <CRS>CRS:84</CRS>
      <Layer>
        <Name>roads</Name>
        <Title>Roads</Title>
        <CRS>EPSG:3857</CRS>
      </Layer>
      <Layer>
        <Name>parcels</Name>
        <Title>Parcels</Title>
        <CRS>EPSG:6706</CRS>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

// A 1.1.1 document with a space-separated SRS list.
const CAPABILITIES_111 = `<?xml version="1.0"?>
<WMT_MS_Capabilities version="1.1.1">
  <Capability>
    <Layer>
      <Title>Root</Title>
      <SRS>EPSG:4326 EPSG:900913 epsg:3003</SRS>
      <Layer><Name>dtm</Name><Title>DTM</Title></Layer>
    </Layer>
  </Capability>
</WMT_MS_Capabilities>`;

describe("WMS capabilities CRS", () => {
  it("reads each layer's CRS codes, inherited ones included", () => {
    const { layers } = parseWmsCapabilities(CAPABILITIES_130);
    assert.deepEqual(layers.find((layer) => layer.name === "roads")?.crs, [
      "EPSG:3857",
      "EPSG:4326",
      "EPSG:25832",
      "CRS:84",
    ]);
    assert.deepEqual(layers.find((layer) => layer.name === "parcels")?.crs, [
      "EPSG:6706",
      "EPSG:4326",
      "EPSG:25832",
      "CRS:84",
    ]);
  });

  it("splits a WMS 1.1.1 SRS list and upper-cases the codes", () => {
    const { layers } = parseWmsCapabilities(CAPABILITIES_111);
    assert.deepEqual(layers[0].crs, ["EPSG:4326", "EPSG:900913", "EPSG:3003"]);
  });

  it("offers the codes every selected layer shares", () => {
    const { layers } = parseWmsCapabilities(CAPABILITIES_130);
    assert.deepEqual(wmsCrsChoices(layers, "roads", "1.3.0"), [
      "EPSG:3857",
      "EPSG:4326",
      "EPSG:25832",
      "CRS:84",
    ]);
    assert.deepEqual(wmsCrsChoices(layers, "roads, parcels", "1.3.0"), [
      "EPSG:4326",
      "EPSG:25832",
      "CRS:84",
    ]);
  });

  it("drops EPSG:900913 and codes the WMS version cannot request", () => {
    const { layers } = parseWmsCapabilities(CAPABILITIES_111);
    assert.deepEqual(wmsCrsChoices(layers, "dtm", "1.1.1"), ["EPSG:4326", "EPSG:3003"]);
    const { layers: layers130 } = parseWmsCapabilities(CAPABILITIES_130);
    // CRS:84 is defined by WMS 1.3.0 only.
    assert.ok(!wmsCrsChoices(layers130, "roads", "1.1.1").includes("CRS:84"));
  });

  it("offers nothing for a layer it does not know", () => {
    const { layers } = parseWmsCapabilities(CAPABILITIES_130);
    assert.deepEqual(wmsCrsChoices(layers, "roads,typed_by_hand", "1.3.0"), []);
    assert.deepEqual(wmsCrsChoices(layers, "", "1.3.0"), []);
  });

  it("tells retrieved layers from layers it knows nothing about", () => {
    const { layers } = parseWmsCapabilities(CAPABILITIES_130);
    assert.equal(wmsLayersAdvertiseCrs(layers, "roads, parcels"), true);
    assert.equal(wmsLayersAdvertiseCrs(layers, "roads,typed_by_hand"), false);
    assert.equal(wmsLayersAdvertiseCrs(layers, ""), false);
    assert.equal(wmsLayersAdvertiseCrs([{ name: "a", title: "a", crs: [] }], "a"), false);
  });

  it("defaults to Web Mercator, else a geographic CRS, else the first code", () => {
    assert.equal(defaultWmsCrs(["EPSG:4326", "EPSG:3857"]), "EPSG:3857");
    assert.equal(defaultWmsCrs(["EPSG:25832", "EPSG:4326"]), "EPSG:4326");
    assert.equal(defaultWmsCrs(["EPSG:25832", "EPSG:3003"]), "EPSG:25832");
    assert.equal(defaultWmsCrs([]), "EPSG:3857");
  });
});
