#!/Users/tc/PythonProject/finance/bin/python
import tushare as ts
import pandas as pd
import os
from datetime import datetime, timedelta

def load_token():
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith('TUSHARE_TOKEN='):
                    return line.split('=', 1)[1].strip().strip('"')
    return os.getenv('TUSHARE_TOKEN')

ts.set_token(load_token())
pro = ts.pro_api()

# 查询603169近10个交易日融资融券数据
# 当前日期20260326，向前回溯约2周
df = pro.margin_detail(
    ts_code='603169.SH',
    start_date='20260310',
    end_date='20260326',
    fields='trade_date,ts_code,exchange_id,rz_ratio,rq_ratio,rzrq_balance,rz_balance,rq_balance,rzye_balance,rzye,net_buy_amount'
)

# 按日期排序（从旧到新）
df = df.sort_values('trade_date').reset_index(drop=True)

print("="*60)
print("603169 兰石重装 融资融券数据 (近10交易日)")
print("="*60)
print(df.to_string(index=False))
print("\n" + "="*60)

# 计算情绪指标
if not df.empty and len(df) >= 2:
    latest = df.iloc[-1]
    first = df.iloc[0]
    
    print("\n【情绪指标分析】")
    print(f"融资余额变化: {first['rz_balance']:.2f}万 → {latest['rz_balance']:.2f}万")
    rz_change = (latest['rz_balance'] - first['rz_balance']) / first['rz_balance'] * 100
    print(f"融资余额变化率: {rz_change:+.2f}%")
    
    print(f"\n融券余额: {latest['rq_balance']:.2f}万")
    
    # 融空比 = 融券余额 / 融资余额
    if latest['rz_balance'] > 0:
        short_ratio = latest['rq_balance'] / latest['rz_balance'] * 100
        print(f"融空比: {short_ratio:.2f}%")
    
    # 融资余额占流通市值的比例（如果有的话）
    print(f"融资融券余额合计: {latest['rzrq_balance']:.2f}万")
    
    # 近5日融资余额趋势
    print("\n【近5日融资余额变化】")
    for i in range(max(0, len(df)-5), len(df)):
        row = df.iloc[i]
        print(f"  {row['trade_date']}: {row['rz_balance']:.2f}万")
    
    # 计算日均融资买入额（如果有net_buy_amount字段）
    if 'net_buy_amount' in df.columns:
        avg_net_buy = df['net_buy_amount'].mean()
        print(f"\n日均净买入: {avg_net_buy:.2f}万")
else:
    print("数据不足，无法计算详细指标")
