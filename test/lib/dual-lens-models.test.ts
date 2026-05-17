import { describe, it, expect } from "vitest";
import {
  DUAL_LENS_DUAL_MOTION_MODELS,
  DUAL_LENS_SINGLE_MOTION_MODELS,
  isDualLenseModel,
} from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

describe("isDualLenseModel", () => {
  it("returns true for canonical Duo PoE / Duo WiFi", () => {
    expect(isDualLenseModel("Reolink Duo PoE")).toBe(true);
    expect(isDualLenseModel("Reolink Duo WiFi")).toBe(true);
  });

  it("returns true for Duo 2 family", () => {
    expect(isDualLenseModel("Reolink Duo 2 PoE")).toBe(true);
    expect(isDualLenseModel("Reolink Duo 2 WiFi")).toBe(true);
  });

  it("returns true for Duo 3 family — regression for PR #22", () => {
    expect(isDualLenseModel("Reolink Duo 3 PoE")).toBe(true);
    expect(isDualLenseModel("Reolink Duo 3 WiFi")).toBe(true);
  });

  it("returns true for TrackMix variants via substring fallback", () => {
    expect(isDualLenseModel("Reolink TrackMix PoE")).toBe(true);
    expect(isDualLenseModel("Reolink TrackMix WiFi")).toBe(true);
    expect(isDualLenseModel("TrackMix some-future-variant")).toBe(true);
  });

  it("returns true for TrackFlex variants via substring fallback", () => {
    expect(isDualLenseModel("TrackFlex Floodlight WiFi")).toBe(true);
    expect(isDualLenseModel("trackflex something")).toBe(true);
  });

  it("returns false for single-lens models that happen to contain 'duo'-like strings", () => {
    // Word-boundary regex prevents false positives.
    expect(isDualLenseModel("RLC-810A")).toBe(false);
    expect(isDualLenseModel("Argus 3 Pro")).toBe(false);
    expect(isDualLenseModel("Reolink Video Doorbell WiFi")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isDualLenseModel("reolink duo 3 wifi")).toBe(true);
    expect(isDualLenseModel("REOLINK TRACKMIX POE")).toBe(true);
  });
});

describe("DUAL_LENS_*_MODELS sets", () => {
  it("dual-motion set covers every Duo family member", () => {
    expect(DUAL_LENS_DUAL_MOTION_MODELS.has("Reolink Duo PoE")).toBe(true);
    expect(DUAL_LENS_DUAL_MOTION_MODELS.has("Reolink Duo WiFi")).toBe(true);
    expect(DUAL_LENS_DUAL_MOTION_MODELS.has("Reolink Duo 2 PoE")).toBe(true);
    expect(DUAL_LENS_DUAL_MOTION_MODELS.has("Reolink Duo 2 WiFi")).toBe(true);
    expect(DUAL_LENS_DUAL_MOTION_MODELS.has("Reolink Duo 3 PoE")).toBe(true);
    expect(DUAL_LENS_DUAL_MOTION_MODELS.has("Reolink Duo 3 WiFi")).toBe(true);
  });

  it("single-motion set covers the TrackMix / TrackFlex family", () => {
    expect(DUAL_LENS_SINGLE_MOTION_MODELS.has("Reolink TrackMix PoE")).toBe(true);
    expect(DUAL_LENS_SINGLE_MOTION_MODELS.has("TrackFlex Floodlight WiFi")).toBe(true);
  });
});
