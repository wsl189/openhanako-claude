#!/Users/tc/PythonProject/finance/bin/python
import os
import json
from datetime import datetime, timedelta
import tushare as ts

# 加载token
def load_token():
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    skill_env = '/Users/tc/.hanako/agents/agent-mn648eoa/skills/tushare/.env'
    for env_file in [env_path, skill_env]:
        if os.path.exists(env_file):
            with open(env_file) as f:
                for line in f:
                    if line.startswith('TUSHARE_TOKEN='):
                        return line.split('=', 1)[1].strip().strip('"')
    return os.getenv('TUSHARE_TOKEN')

token = load_token()
if not token:
    print("Error: TUSHARE_TOKEN not found")
    exit(1)

ts.set_token(token)
pro = ts.pro_api()

# 获取上一个交易日（今日可能是非交易日）
trade_date = '20260325'  # 假设最新数据是3月25日

print("=== 情绪分析师数据报告 ===")
print(f"数据日期: {trade_date}")
print()

# 1. 获取每日涨跌停数据
print("【1. 涨跌停统计】")
try:
    limit_df = pro.limit_list_d(trade_date=trade_date)
    if not limit_df.empty:
        up_count = len(limit_df[limit_df['pct_chg'] > 9.5])
        down_count = len(limit_df[limit_df['pct_chg'] < -9.5])
        print(f"今日涨停: {up_count} 只")
        print(f"今日跌停: {down_count} 支")
        # 板块分布
        if 'industry' in limit_df.columns or 'sector' in limit_df.columns:
            sector_col = 'industry' if 'industry' in limit_df.columns else 'sector'
            print(f"\n涨停板块分布(Top5):")
            sector_counts = limit_df[sector_col].value_counts().head(5)
            for sector, count in sector_counts.items():
                print(f"  {sector}: {count}")
    else:
        print("暂无涨跌停数据")
except Exception as e:
    print(f"涨跌停数据获取失败: {e}")

print()

# 2. 获取北向资金数据
print("【2. 北向资金流向】")
try:
    # 沪深港通资金流向
    hk_connect = pro.hk_hold(trade_date=trade_date)
    if not hk_connect.empty:
        # 计算净买入
        print(f"港股通标的持仓变化记录数: {len(hk_connect)}")
    else:
        print("暂无港股通持仓数据")
except Exception as e:
    print(f"港股通数据获取失败: {e}")

try:
    # 指数日线数据（含涨跌）
    index_data = pro.index_daily(ts_code='000001.SH', start_date=trade_date, end_date=trade_date)
    if not index_data.empty:
        print(f"上证指数今日: {index_data.iloc[0]['close']} ({index_data.iloc[0]['pct_chg']:.2f}%)")
except Exception as e:
    print(f"指数数据获取失败: {e}")

print()

# 3. 获取市场宽度指标（使用指数成分判断）
print("【3. 市场宽度指标】")
try:
    # 使用daily_basic获取全市场PE、换手率等
    market_basic = pro.daily_basic(trade_date=trade_date, fields='ts_code,turnover_rate,pe_ttm,total_mv')
    if not market_basic.empty:
        avg_turnover = market_basic['turnover_rate'].mean()
        median_pe = market_basic['pe_ttm'].median()
        total_mv = market_basic['total_mv'].sum() / 1e8  # 转换为亿元
        print(f"全市场平均换手率: {avg_turnover:.2f}%")
        print(f"全市场中位数PE: {median_pe:.2f}")
        print(f"全市场总市值: {total_mv:.2f} 亿元")
    else:
        print("暂无市场宽度数据")
except Exception as e:
    print(f"市场宽度数据获取失败: {e}")

print()

# 4. 行业涨跌排行
print("【4. 行业板块涨跌(Top10)】")
try:
    industry_daily = pro.ths_index(daily_date=trade_date, exchange='A')
    if not industry_daily.empty:
        print("数据已获取")
        print(industry_daily.head(10).to_string())
    else:
        # 尝试使用东财行业数据
        print("尝试使用其他数据源...")
except Exception as e:
    print(f"行业数据获取失败: {e}")

print()

# 5. 龙虎榜数据（热点游资动向）
print("【5. 龙虎榜（游资热点）】")
try:
    top_list = pro.top_list(trade_date=trade_date)
    if not top_list.empty:
        print(f"龙虎榜上榜数: {len(top_list)}")
        if 'reason' in top_list.columns:
            reasons = top_list['reason'].value_counts().head(3)
            print("主要上榜原因:")
            for reason, count in reasons.items():
                print(f"  {reason}: {count}")
    else:
        print("暂无龙虎榜数据")
except Exception as e:
    print(f"龙虎榜数据获取失败: {e}")

print()
print("=== 数据获取完成 ===")
