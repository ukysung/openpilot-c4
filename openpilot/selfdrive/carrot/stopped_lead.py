import numpy as np

# 선행차 속도(m/s): 2 이하에서 정지차 comfort brake, 8 이상에서 기존 comfort brake
STOPPED_LEAD_V_BP = [2.0, 8.0]


def get_stopped_lead_comfort_brake(comfort_brake: float, lead_status: bool, v_lead: float,
                                   stopped_lead_comfort_brake: float) -> float:
  # 정지/저속 선행차일 때만 comfort brake를 낮춰 더 멀리서부터 감속 시작, 주행중인 선행차의 차간거리는 그대로
  if not lead_status or stopped_lead_comfort_brake <= 0.0 or stopped_lead_comfort_brake >= comfort_brake:
    return comfort_brake
  return float(np.interp(v_lead, STOPPED_LEAD_V_BP, [stopped_lead_comfort_brake, comfort_brake]))
