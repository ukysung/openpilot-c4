"""
# 1. SSH 접속
ssh comma@192.168.43.1

# 2. 스크립트 실행
python3 /tmp/trailer_capture.py
PC로 파일 복사 (로컬 터미널에서):

Copyscp comma@192.168.43.1:/tmp/before.log .
scp comma@192.168.43.1:/tmp/after_connected.log .
scp comma@192.168.43.1:/tmp/after_disconnected.log .
"""


import subprocess, time, os

def wait_ready(msg):
    print(f"\n{msg}")
    input("준비되면 Enter 입력 >>> ")

def capture_can(filename, duration=15):
    print(f"\n  [{filename}] CAN 캡처 시작... ({duration}초)")
    proc = subprocess.Popen(
        ["python3", "/data/openpilot/selfdrive/debug/can_printer.py"],
        stdout=open(f"/tmp/{filename}", "w"),
        stderr=subprocess.STDOUT
    )
    for i in range(duration, 0, -1):
        print(f"  캡처 중... 남은시간 {i}초", end="\r")
        time.sleep(1)
    proc.terminate()
    proc.wait()
    print(f"\n  [{filename}] 캡처 완료 ✓")

def main():
    print("=" * 50)
    print("트레일러 CAN 신호 캡처 도구")
    print("=" * 50)

    # STEP 1
    wait_ready(
        "[STEP 1] 준비사항 확인\n"
        "  - 차량 IGN ON 상태 (시동 불필요)\n"
        "  - 트레일러 전기 커넥터 분리 상태\n"
        "  - comma 3X 정상 부팅 확인"
    )

    # STEP 2
    print("\n[STEP 2] 트레일러 미연결 상태 캡처 중...")
    capture_can("before.log", duration=15)

    # STEP 3
    wait_ready(
        "[STEP 3] 트레일러 연결\n"
        "  - 히치 걸쇠 체결\n"
        "  - 전기 커넥터 완전히 연결\n"
        "  - 계기판에 트레일러 아이콘 또는 메뉴 표시 확인"
    )

    # STEP 4
    print("\n[STEP 4] 트레일러 연결 상태 캡처 중...")
    capture_can("after_connected.log", duration=15)

    # STEP 5
    wait_ready(
        "[STEP 5] 트레일러 분리\n"
        "  - 전기 커넥터 분리\n"
        "  - 히치 걸쇠 해제\n"
        "  - 계기판 트레일러 아이콘 사라짐 확인"
    )

    # STEP 6
    print("\n[STEP 6] 트레일러 분리 상태 캡처 중...")
    capture_can("after_disconnected.log", duration=15)

    # 완료
    print("\n" + "=" * 50)
    print("  캡처 완료! 생성된 파일:")
    print("  - /tmp/before.log             (연결 전)")
    print("  - /tmp/after_connected.log    (연결 후)")
    print("  - /tmp/after_disconnected.log (분리 후)")
    print("=" * 50)
    print("\n아래 명령어로 PC에 복사하세요:")
    print("  scp comma@192.168.43.1:/tmp/before.log .")
    print("  scp comma@192.168.43.1:/tmp/after_connected.log .")
    print("  scp comma@192.168.43.1:/tmp/after_disconnected.log .")

if __name__ == "__main__":
    main()