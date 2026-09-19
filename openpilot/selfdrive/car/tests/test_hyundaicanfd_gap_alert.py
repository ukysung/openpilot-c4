from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


class CanBusBase:
  def __init__(self, CP, fingerprint=None):
    self.offset = 0


class HyundaiFlags:
  CAMERA_SCC = SimpleNamespace(value=1)


def load_hyundaicanfd():
  fake_modules = {
    "opendbc.car": SimpleNamespace(CanBusBase=CanBusBase),
    "opendbc.car.crc": SimpleNamespace(CRC16_XMODEM=[0] * 256),
    "opendbc.car.hyundai.values": SimpleNamespace(HyundaiFlags=HyundaiFlags, HyundaiExtFlags=SimpleNamespace()),
    "openpilot.common.params": SimpleNamespace(Params=FakeParams),
    "opendbc.car.common.conversions": SimpleNamespace(Conversions=SimpleNamespace(MS_TO_KPH=3.6, MS_TO_MPH=2.236936)),
    "opendbc.car.carlog": SimpleNamespace(carlog=SimpleNamespace(info=print, warning=print, error=print)),
    "cereal": SimpleNamespace(log=SimpleNamespace(LaneChangeState=object, LaneChangeDirection=object, Desire=object)),
    "openpilot.cereal": SimpleNamespace(log=SimpleNamespace(LaneChangeState=object, LaneChangeDirection=object, Desire=object)),
  }
  repo_root = next(parent for parent in Path(__file__).parents if (parent / "opendbc_repo").is_dir())
  module_path = repo_root / "opendbc_repo" / "opendbc" / "car" / "hyundai" / "hyundaicanfd.py"
  spec = importlib.util.spec_from_file_location("hyundaicanfd_gap_alert_test_target", module_path)
  module = importlib.util.module_from_spec(spec)
  with pytest.MonkeyPatch.context() as monkeypatch:
    for name, fake_module in fake_modules.items():
      monkeypatch.setitem(sys.modules, name, fake_module)
    spec.loader.exec_module(module)
  return module


class FakePacker:
  def make_can_msg(self, name, bus, values, **kwargs):
    return name, bus, deepcopy(values)


class FakeParams:
  def get_int(self, key):
    return 0

  def get(self, key):
    return b"0"


hyundaicanfd = load_hyundaicanfd()


def create_ccnc_alert(monkeypatch, alert, gap, sound=1):
  monkeypatch.setattr(hyundaicanfd, "Params", FakeParams)

  CP = SimpleNamespace(flags=HyundaiFlags.CAMERA_SCC.value)
  CAN = SimpleNamespace(CAM=2, ECAN=0)
  CC = SimpleNamespace(enabled=True, latActive=False)
  CS = SimpleNamespace(
    MD=None,
    modelV2=None,
    lfahda_cluster=None,
    cruise_buttons_msg=None,
    adrv_0x161={
      "COUNTER": 0,
      "ALERTS_1": 0,
      "ALERTS_2": 0,
      "ALERTS_3": alert,
      "ALERTS_5": 0,
      "SOUNDS_3": sound,
    },
    adrv_0x200=None,
    adrv_0x1ea=None,
    ccnc_0x162=None,
    is_metric=True,
    paddle_button_prev=0,
    trailer_connected=False,
    softHoldActive=0,
    scc_control=None,
    ACCMode=0,
    MainMode_ACC=False,
    cruise_btns_msg_canfd=None,
    adrv_0x160=None,
    out=SimpleNamespace(
      cruiseState=SimpleNamespace(available=True),
      brakeHoldActive=False,
      parkingBrake=False,
      vehicleNaviAvailable=False,
      vEgo=0.0,
      latEnabled=False,
      steeringAngleDeg=0.0,
      leftLaneLine=0,
      rightLaneLine=0,
      leftBlindspot=False,
      rightBlindspot=False,
      leftBlinker=False,
      rightBlinker=False,
    ),
  )
  hud_control = SimpleNamespace(
    activeCarrot=0,
    setSpeed=25.0,
    leadDistanceBars=gap,
    leadVisible=False,
    leadDistance=0.0,
    leftLaneDepart=False,
    rightLaneDepart=False,
    leftLaneVisible=False,
    rightLaneVisible=False,
  )

  messages = hyundaicanfd.create_ccnc_messages(
    CP, FakePacker(), CAN, 5, CC, CS, hud_control,
    0.0, False, False, 0, False, 0, 0,
  )
  return messages[0][2]


@pytest.mark.parametrize(("raw_alert", "gap", "expected_alert"), [
  (9, 1, 7),
  (10, 2, 8),
  (7, 3, 9),
  (8, 4, 10),
  (11, 1, 7),
  (14, 4, 10),
])
def test_gap_alert_matches_selected_distance(monkeypatch, raw_alert, gap, expected_alert):
  values = create_ccnc_alert(monkeypatch, raw_alert, gap)

  assert values["ALERTS_3"] == expected_alert
  assert values["SOUNDS_3"] == 1


def test_non_gap_alert_remains_suppressed(monkeypatch):
  values = create_ccnc_alert(monkeypatch, 17, 2)

  assert values["ALERTS_3"] == 0
  assert values["SOUNDS_3"] == 0
