/**
 * 写 YAML 的两条纪律。
 *
 * 目录文件(index/catalog.yml、capabilities.yml)是这个产品的数据本体,而它们
 * 是拼字符串拼出来的——所以必须有一个统一的标量序列化器,和一道"写之前先解析"
 * 的闸。
 *
 * 起因是一次真事:register 逐字段决定要不要加引号,唯独漏了 license。收录
 * OSV.dev 时许可证写作 `Apache-2.0 (OSV data: per-source, …)`,里头那个 ": "
 * 让 YAML 把它读成嵌套映射,index/catalog.yml 从此整份解析不了——而 register
 * 报的是 ok,坏字节就这么提交上去了。
 */
import yaml from 'js-yaml'

/**
 * 一个 YAML 标量。JSON 字符串本身就是合法的 YAML 双引号标量,所以这里既正确
 * 又无聊——无聊正是要点:凡是写进 YAML 的值都走这一条路,没有"这个字段大概
 * 不用引号"的判断空间。
 */
export function s(v) {
  return JSON.stringify(String(v ?? ''))
}

/**
 * 断言这段文本是合法 YAML;不合法就抛,由调用方决定怎么拒绝。
 * 拿它守在写入之前:一次把目录写坏却报成功的 register,比一次拒绝写入糟得多。
 * `s()` 挡的是已知的那种破法,这道闸挡的是下一种还没见过的。
 */
export function assertYaml(text, label) {
  try {
    yaml.load(text)
  } catch (error) {
    const first = String(error?.message ?? error).split('\n')[0]
    throw new Error(`${label} 不是合法 YAML:${first}`)
  }
  return text
}
