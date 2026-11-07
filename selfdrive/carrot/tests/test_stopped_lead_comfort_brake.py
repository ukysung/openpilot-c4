import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


class FakeEnum:
  def __getattr__(self, name):
    return name


def load_carrot_functions():
  fake_log = SimpleNamespace(
    OnroadEvent=SimpleNamespace(EventName=FakeEnum()),
    LaneChangeState=FakeEnum(),
    LongitudinalPersonality=FakeEnum(),
  )
  fake_modules = {
    "cereal": SimpleNamespace(log=fake_log),
    "openpilot.common.params": SimpleNamespace(Params=object),
    "openpilot.common.realtime": SimpleNamespace(DT_MDL=0.05),
    "openpilot.common.constants": SimpleNamespace(CV=SimpleNamespace(KPH_TO_MS=1 / 3.6, MS_TO_KPH=3.6)),
    "openpilot.common.filter_simple": SimpleNamespace(MyMovingAverage=object),
    "openpilot.selfdrive.selfdrived.events": SimpleNamespace(Events=object),
  }
  module_path = Path(__file__).parents[1] / "carrot_functions.py"
  spec = importlib.util.spec_from_file_location("carrot_functions_stopped_lead_test_target", module_path)
  module = importlib.util.module_from_spec(spec)
  with pytest.MonkeyPatch.context() as monkeypatch:
    for name, fake_module in fake_modules.items():
      monkeypatch.setitem(sys.modules, name, fake_module)
    spec.loader.exec_module(module)
  return module


@pytest.fixture(scope="module")
def get_cb():
  return load_carrot_functions().get_stopped_lead_comfort_brake


def test_default_setting_keeps_comfort_brake(get_cb):
  # 240 (default) == base comfort brake -> no change even for stopped lead
  assert get_cb(2.4, True, 0.0, 2.4) == 2.4


def test_no_lead_keeps_comfort_brake(get_cb):
  assert get_cb(2.4, False, 0.0, 1.8) == 2.4


def test_stopped_lead_uses_setting(get_cb):
  assert get_cb(2.4, True, 0.0, 1.8) == pytest.approx(1.8)
  assert get_cb(2.4, True, 2.0, 1.8) == pytest.approx(1.8)


def test_moving_lead_keeps_comfort_brake(get_cb):
  assert get_cb(2.4, True, 8.0, 1.8) == pytest.approx(2.4)
  assert get_cb(2.4, True, 25.0, 1.8) == pytest.approx(2.4)


def test_slow_lead_blends(get_cb):
  assert get_cb(2.4, True, 5.0, 1.8) == pytest.approx(2.1)


def test_setting_never_raises_comfort_brake(get_cb):
  # eco/safe mode or traffic stop may already lower comfort brake below the setting
  assert get_cb(1.92, True, 0.0, 2.0) == pytest.approx(1.92)


def test_invalid_setting_is_ignored(get_cb):
  assert get_cb(2.4, True, 0.0, 0.0) == 2.4
