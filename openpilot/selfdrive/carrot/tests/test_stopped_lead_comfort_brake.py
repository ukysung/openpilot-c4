import json
from pathlib import Path

import pytest

from openpilot.selfdrive.carrot.stopped_lead import get_stopped_lead_comfort_brake as get_cb

SETTINGS_PATH = Path(__file__).resolve().parents[2] / "carrot_settings.json"
PARAMS_KEYS_PATH = Path(__file__).resolve().parents[3] / "common" / "params_keys.h"


def _menu_param_names(nodes):
  names = set()
  for node in nodes:
    names.update(node.get("params", []))
    names |= _menu_param_names(node.get("groups", []))
  return names


def test_setting_is_registered_and_shown_in_menu():
  settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
  assert any(p["name"] == "StoppedLeadComfortBrake" for p in settings["params"])
  # the web settings page only lists params that appear in the "menu" tree
  assert "StoppedLeadComfortBrake" in _menu_param_names(settings["menu"])
  assert '{"StoppedLeadComfortBrake", {PERSISTENT, INT, "240"}}' in PARAMS_KEYS_PATH.read_text(encoding="utf-8")


def test_default_setting_keeps_comfort_brake():
  # 240 (default) == base comfort brake -> no change even for stopped lead
  assert get_cb(2.4, True, 0.0, 2.4) == 2.4


def test_no_lead_keeps_comfort_brake():
  assert get_cb(2.4, False, 0.0, 1.8) == 2.4


def test_stopped_lead_uses_setting():
  assert get_cb(2.4, True, 0.0, 1.8) == pytest.approx(1.8)
  assert get_cb(2.4, True, 2.0, 1.8) == pytest.approx(1.8)


def test_moving_lead_keeps_comfort_brake():
  assert get_cb(2.4, True, 8.0, 1.8) == pytest.approx(2.4)
  assert get_cb(2.4, True, 25.0, 1.8) == pytest.approx(2.4)


def test_slow_lead_blends():
  assert get_cb(2.4, True, 5.0, 1.8) == pytest.approx(2.1)


def test_setting_never_raises_comfort_brake():
  # a traffic stop may already lower comfort brake below the setting
  assert get_cb(2.16, True, 0.0, 2.2) == pytest.approx(2.16)


def test_invalid_setting_is_ignored():
  assert get_cb(2.4, True, 0.0, 0.0) == 2.4
