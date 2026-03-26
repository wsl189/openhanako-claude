#!/Users/tc/PythonProject/finance/bin/python
import os
import tushare as ts
import pandas as pd

def load_token():
    paths = [
        '/Users/tc/PythonProject/openhanako/.env',
        '/Users/tc/.hanako/agents/agent-mn648eoa/skills/tushare/.env'
    ]
    for p in paths:
        if os.path.exists(p):
            with open(p) as f:
                for line in f:
                    if line.startswith('TUSHARE_TOKEN='):
                        return line.split('=', 1)[1].strip().strip('"')
    return os.getenv('TUSHARE_TOKEN')

token = load_token()
ts.set_token(token)
pro = ts.pro_api()

# 检查可用字段
print("测试融资融券基础接口字段...")
try:
    df = pro.margin(trade_date='20260325')
    print(f"可用字段: {df.columns.tolist()}")
    if not df.empty:
        print(df.head(3))
except Exception as e:
    print(f"失败: {e}")

# 获取近期融资融券汇总
print("\n获取近5日融资融券汇总...")
try:
    df = pro.margin(start_date='20260320', end_date='20260326')
    if not df.empty:
        print(df)
    else:
        print("无数据")
except Exception as e:
    print(f"失败: {e}")

# 获取涨跌停统计
print("\n获取涨跌停数据...")
try:
    up = pro.limit_list_d(trade_date='20260325', direction='U')
    down = pro.limit_list_d(trade_date='20260325', direction='D')
    print(f"涨停: {len(up)}, 跌停: {len(down)}")
except Exception as e:
    print(f"涨跌停失败: {e}")
