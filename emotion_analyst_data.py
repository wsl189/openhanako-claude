#!/Users/tc/PythonProject/finance/bin/python
import os
import tushare as ts
import pandas as pd
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

today = datetime.now().strftime('%Y%m%d')
five_days_ago = (datetime.now() - timedelta(days=7)).strftime('%Y%m%d')

print("="*60)
print("情绪分析师数据收集报告 - 伊朗局势对A股影响评估")
print(f"数据日期范围: {five_days_ago} 至 {today}")
print("="*60)

# 1. 涨跌停数量统计
print("\n【1. 涨跌停数量统计】")
try:
    limit_up = pro.limit_list_d(trade_date=today, direction='U')
    limit_down = pro.limit_list_d(trade_date=today, direction='D')
    print(f"今日涨停数量: {len(limit_up)}")
    print(f"今日跌停数量: {len(limit_down)}")
    if not limit_up.empty:
        print(f"涨停板块分布: {limit_up['indu_code'].value_counts().head(5).to_dict()}")
except Exception as e:
    print(f"涨跌停数据获取失败: {e}")

# 2. 融资融券数据（沪深全市场）
print("\n【2. 全市场融资融券余额】")
try:
    margin = pro.margin(start_date=five_days_ago, end_date=today)
    if not margin.empty:
        margin = margin.sort_values('trade_date')
        print(margin[['trade_date', 'rzye', 'rqye', 'rzmre', 'rzjmre']].to_string())
    else:
        print("暂无数据")
except Exception as e:
    print(f"融资融券数据获取失败: {e}")

# 3. 北向资金（沪深港通）
print("\n【3. 北向资金流向】")
try:
    hkex = pro.hk_hold(trade_date=today)
    if not hkex.empty:
        print(f"北向资金持股数量: {len(hkex)}")
    else:
        # 尝试获取沪深港通资金流向
        sh_moneyflow = pro.sgt_top_em(export='北向', date=today)
        if not sh_moneyflow.empty:
            print(sh_moneyflow.head())
        else:
            print("暂无北向资金数据")
except Exception as e:
    print(f"北向资金数据获取失败: {e}")

# 4. 上证指数表现
print("\n【4. 大盘指数表现】")
try:
    sh_index = pro.index_daily(ts_code='000001.SH', start_date=five_days_ago, end_date=today)
    if not sh_index.empty:
        sh_index = sh_index.sort_values('trade_date')
        print(sh_index[['trade_date', 'close', 'pct_chg', 'vol']].to_string())
except Exception as e:
    print(f"指数数据获取失败: {e}")

# 5. 重点板块涨跌
print("\n【5. 重点受益板块个股表现】")
sectors = {
    '石油石化': ['601857.SH', '600028.SH', '600546.SH'],
    '军工': ['600893.SH', '000768.SZ', '002013.SZ'],
    '航运': ['601919.SH', '600026.SH', '601866.SH'],
    '化工(甲醇)': ['600256.SH', '000683.SZ', '600230.SH']
}

for sector_name, codes in sectors.items():
    print(f"\n--- {sector_name} ---")
    for code in codes:
        try:
            df = pro.daily(ts_code=code, start_date=five_days_ago, end_date=today)
            if not df.empty:
                df = df.sort_values('trade_date')
                latest = df.iloc[0]
                prev = df.iloc[-1] if len(df) > 1 else latest
                print(f"{code}: 最新价={latest['close']}, 涨跌幅={latest['pct_chg']}%, 近5日区间涨跌={(latest['close']/prev['close']-1)*100:.1f}%")
        except Exception as e:
            print(f"{code}数据获取失败: {e}")

print("\n" + "="*60)
print("数据收集完毕")
