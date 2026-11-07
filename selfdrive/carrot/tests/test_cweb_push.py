from openpilot.selfdrive.carrot import cweb_push


class FakeParams:
  def __init__(self, values=None):
    self.values = values or {}

  def get(self, key):
    return self.values.get(key)


def make_reporter(monkeypatch, ips, posts, ok=True):
  ip_iter = iter(ips)
  monkeypatch.setattr(cweb_push, "get_local_ip", lambda iface: next(ip_iter))
  monkeypatch.setattr(cweb_push, "post_json", lambda url, payload, timeout_s: (posts.append((url, payload)) or (ok, 200 if ok else 500, "")))
  clock = [100.0]
  monkeypatch.setattr(cweb_push.time, "monotonic", lambda: clock[0])
  reporter = cweb_push.CwebPushReporter(
    params=FakeParams({"DongleId": b"abc123"}),
    report_url="https://example.test/report",
    heartbeat_url="https://example.test/heartbeat",
    iface="wlan0",
    port=7000,
    timeout_s=1.0,
    heartbeat_interval_s=10.0,
    debounce_s=1.0,
  )
  return reporter, clock


def test_default_report_url_decodes():
  assert cweb_push._decode_default_report_url() == "https://cwp.jominki354.live/report"
  assert cweb_push._default_heartbeat_url("https://cwp.jominki354.live/report") == "https://cwp.jominki354.live/heartbeat"


def test_device_id_prefers_dongle_then_serial():
  assert cweb_push.device_id(FakeParams({"DongleId": b"dongle", "HardwareSerial": b"serial"})) == "dongle"
  assert cweb_push.device_id(FakeParams({"DongleId": b"UnregisteredDevice", "HardwareSerial": b"serial"})) == "serial"


def test_usable_ip_rejects_loopback_and_link_local():
  assert cweb_push._usable_ip("192.168.0.10") == "192.168.0.10"
  assert cweb_push._usable_ip("127.0.0.1") == ""
  assert cweb_push._usable_ip("169.254.1.2") == ""
  assert cweb_push._usable_ip("not-an-ip") == ""


def test_reports_once_ip_is_stable(monkeypatch):
  posts = []
  reporter, clock = make_reporter(monkeypatch, ["192.168.0.10"] * 3, posts)

  assert reporter.poll_once() is False  # first sighting starts debounce
  clock[0] += 0.5
  assert reporter.poll_once() is False  # still debouncing
  clock[0] += 1.0
  assert reporter.poll_once() is True
  assert posts == [("https://example.test/report", {"deviceId": "abc123", "ip": "192.168.0.10", "port": 7000})]


def test_failed_report_backs_off(monkeypatch):
  posts = []
  reporter, clock = make_reporter(monkeypatch, ["10.0.0.5"] * 4, posts, ok=False)

  reporter.poll_once()
  clock[0] += 2.0
  assert reporter.poll_once() is False
  assert len(posts) == 1
  clock[0] += 1.0
  assert reporter.poll_once() is False  # inside backoff window, no retry
  assert len(posts) == 1
