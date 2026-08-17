# 收录工单(客户接口):petstore-demo

来源 spec:https://petstore3.swagger.io/api/v3/openapi.json
接口标题:Swagger Petstore - OpenAPI 3.0 1.0.27
Base URL:/api/v3
客户:acme(零件写入 catalogs/acme/,与公共目录隔离)

## 端点清单(共 19 个,已按 tag 归组)

### pet(8 个端点)
  - POST /pet +body — Add a new pet to the store.
  - PUT /pet +body — Update an existing pet.
  - GET /pet/findByStatus [status*(query)] — Finds Pets by status.
  - GET /pet/findByTags [tags*(query)] — Finds Pets by tags.
  - GET /pet/{petId} [petId*(path)] — Find pet by ID.
  - POST /pet/{petId} [petId*(path), name(query), status(query)] — Updates a pet in the store with form data.
  - DELETE /pet/{petId} [api_key(header), petId*(path)] — Deletes a pet.
  - POST /pet/{petId}/uploadImage [petId*(path), additionalMetadata(query)] +body — Uploads an image.

### store(4 个端点)
  - GET /store/inventory — Returns pet inventories by status.
  - POST /store/order +body — Place an order for a pet.
  - GET /store/order/{orderId} [orderId*(path)] — Find purchase order by ID.
  - DELETE /store/order/{orderId} [orderId*(path)] — Delete purchase order by identifier.

### user(7 个端点)
  - POST /user +body — Create user.
  - POST /user/createWithList +body — Creates list of users with given input array.
  - GET /user/login [username(query), password(query)] — Logs user into the system.
  - GET /user/logout — Logs out current logged in user session.
  - GET /user/{username} [username*(path)] — Get user by user name.
  - PUT /user/{username} [username*(path)] +body — Update user resource.
  - DELETE /user/{username} [username*(path)] — Delete user resource.

## 要写的两个文件

1. **index.js** — MCP stdio 适配服务器(照抄 generated/geocode/index.js 的户型)
   - **从上面清单里挑 2~5 个最有业务价值的端点**做成工具:一个工具 = 一个 agent 说得清楚的完整动作,不要把端点一对一翻译成工具
   - 用内置 fetch;超时 AbortSignal.timeout(15000);明确 User-Agent;返回体裁剪
   - 非 2xx / 超时 / 解析失败一律 { isError: true, ... } 并说清是哪个接口什么问题
   - 传输层失败重试一次并绕开代理(参照 generated/sec-filings/index.js 的 fetchWithProxyFallback)
   - **凭证从自己进程的环境变量读**,绝不写进代码、绝不当工具参数;未配时 listTools 照常成功、调用给出可行动错误
   - **写操作**(POST/PUT/DELETE)的 description 必须以【写操作,会真实修改客户系统】开头
2. **smoke.mjs** — 冒烟(check() 计数,process.exit(failures))
   - listTools 断言 + 每个工具真实调用(或零凭证降级路径)+ 错误路径
   - 用 NETWORK_ENV 写法把代理环境传给子进程(见 generated/geocode/smoke.mjs)
   - 断言结构与量纲,不断言易变的具体值
