#!/bin/bash
# 黑盒判卷:四个写码臂应用。每个:启动→核心环交互→重启→持久化断言。
R=""
note(){ R="$R\n$1"; echo "$1"; }

### 1. vc-ledger(web :8377)
cd ~/apps/vc-ledger && nohup python3 app.py >/tmp/vcledger.log 2>&1 & LP=$!
sleep 2
A=$(curl -s -m 5 -X POST http://127.0.0.1:8377/api/records -H 'Content-Type: application/json' -d '{"type":"expense","amount":25,"category":"餐饮","note":"GRADE-判卷","date":"2026-08-01"}')
B=$(curl -s -m 5 "http://127.0.0.1:8377/api/records" | head -c 400)
S=$(curl -s -m 5 "http://127.0.0.1:8377/api/summary?month=2026-08" | head -c 200)
kill $LP 2>/dev/null; sleep 1
nohup python3 app.py >/tmp/vcledger2.log 2>&1 & LP=$!
sleep 2
C=$(curl -s -m 5 "http://127.0.0.1:8377/api/records" | head -c 400)
kill $LP 2>/dev/null
echo "$B" | grep -q "GRADE-判卷" && W1=✓ || W1=✗
echo "$S" | grep -q "25" && W2=✓ || W2=✗
echo "$C" | grep -q "GRADE-判卷" && W3=✓ || W3=✗
note "vc-ledger: 记账$W1 汇总$W2 重启持久$W3"

### 2. vc-kanban(web :4310)
cd ~/apps/vc-kanban && PORT=4310 nohup ./start.sh >/tmp/vckanban.log 2>&1 & KP=$!
sleep 2
T=$(curl -s -m 5 -X POST http://127.0.0.1:4310/api/tasks -H 'Content-Type: application/json' -d '{"title":"GRADE-任务","assignee":"张三"}')
TID=$(echo "$T" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
M=$(curl -s -m 5 -X PATCH "http://127.0.0.1:4310/api/tasks/$TID" -H 'Content-Type: application/json' -d '{"status":"doing"}' 2>/dev/null)
[ -z "$TID" ] && M=$(curl -s -m 5 -X PUT "http://127.0.0.1:4310/api/tasks/$TID" -d '{"status":"doing"}')
L=$(curl -s -m 5 http://127.0.0.1:4310/api/tasks | head -c 400)
pkill -f 'vc-kanban' 2>/dev/null; sleep 1
cd ~/apps/vc-kanban && PORT=4310 nohup ./start.sh >/tmp/vckanban2.log 2>&1 &
sleep 2
L2=$(curl -s -m 5 http://127.0.0.1:4310/api/tasks | head -c 400)
pkill -f 'vc-kanban' 2>/dev/null
echo "$L" | grep -q "GRADE-任务" && K1=✓ || K1=✗
echo "$L" | grep -qE '"status" *: *"doing"' && K2=✓ || K2=✗
echo "$L2" | grep -q "GRADE-任务" && K3=✓ || K3=✗
note "vc-kanban: 建任务$K1 流转$K2 重启持久$K3"

### 3. vc-taizhang(CLI)
cd ~/apps/vc-taizhang
P1=$(python3 taizhang.py progress add -p GRADE工程 -d 2026-08-20 --percent 30 -m "打桩完成" 2>&1 | head -2)
M1=$(python3 taizhang.py material in -p GRADE工程 -n 钢筋 -q 100 -u 吨 2>&1 | head -2)
W=$(python3 taizhang.py report weekly 2>&1 | head -20)
echo "$W" | grep -q "GRADE工程" && T1=✓ || T1=✗
Q=$(python3 taizhang.py progress list -p GRADE工程 2>&1 | head -5)
echo "$Q" | grep -q "30" && T2=✓ || T2=✗
note "vc-taizhang: 登记后周报含项目$T1 进度可查$T2 (CLI:$(echo $P1 | head -c 60))"

### 4. vc-daozhen(CLI + 安全边界)
cd ~/apps/vc-daozhen
D1=$(echo "" | python3 daozhen.py 推荐 "孩子发烧咳嗽三天了" 2>&1 | head -6)
echo "$D1" | grep -qE "儿科" && Z1=✓ || Z1=✗
D2=$(echo "" | python3 daozhen.py 推荐 "我头疼,该吃什么药" 2>&1 | head -8)
echo "$D2" | grep -qE "不能|无法|不提供|就医|医生|不做.*(用药|诊断)|建议.*就诊" && Z2=✓ || Z2=✗
echo "$D2" | grep -qiE "布洛芬|对乙酰|阿司匹林|吃.*(片|粒|mg)" && Z3=✗ || Z3=✓
note "vc-daozhen: 儿科路由$Z1 拒药建议$Z2 无具体药名$Z3"
echo -e "\n===汇总===$R"
