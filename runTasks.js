const fs = require('fs').promises;
const yaml = require('yaml');
const puppeteer = require('puppeteer');
const lighthouse = require('lighthouse');
const { resolve } = require('path');
const { exec } = require('child_process');

// 封装 Shell 调用函数
function callShell(command) {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout) => {
      if (err) {
        console.error('Fail to callShell', err);
        reject(err);
      }
      resolve(stdout);
    });
  });
}

// 封装 try-catch 函数
async function tryCatch(promise) {
  try {
    const result = await promise;
    return [result, null];
  } catch (error) {
    return [null, error];
  }
}

async function runTasks() {
  // 读取任务配置文件
  const configYaml = await fs.readFile('tasks.yaml', 'utf8');
  const config = yaml.parse(configYaml);

  // 启动 Whistle 代理并添加代理规则（如果提供了代理配置文件）
  let proxy;
  if (config.whistleFile) {
    // 开启 Whistle
    const [, whistleErr] = await tryCatch(callShell('w2 start -M "prod|capture"'));
    if (whistleErr) {
      console.log('❌ 开启 Whistle 代理失败');
      process.exit(1);
    }
    console.log('✅ 开启 Whistle 代理成功');

    // 添加 Whistle 配置
    const [, proxyErr] = await tryCatch(callShell(`w2 use ${config.whistleFile} --force`));
    if (proxyErr) {
      console.log('❌ 添加 Whistle 配置失败');
      process.exit(1);
    }
    proxy = 'http://127.0.0.1:8899';
  }

  // 启动 Puppeteer
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--enable-accelerated-2d-canvas',
    '--enable-aggressive-domstorage-flushing',
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
    '--lang=zh-CN',
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  const browser = await puppeteer.launch({
    args,
    ignoreHTTPSErrors: true,
    headless: true,
    timeout: 100000,
  });

  const results = [];
  // 遍历任务列表
  for (const task of config.taskList) {
    console.log(`Running task: ${task.title} (${task.key})`);

    // 为 Lighthouse 准备运行环境
    const page = await browser.newPage();
    await page.setDefaultTimeout(60000);
    await page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent(config.userAgent);
    const viewport = {
      width: config.mobile ? 375 : 1920,
      height: config.mobile ? 812 : 1080,
    };
    await page.setViewport(viewport);
    await page.setCookie(...config.cookies);
    await page.goto(task.url, { waitUntil: 'networkidle0' });
    await page.setCacheEnabled(false);

    // 创建一个新的 Chrome 连接
    const endpoint = browser.wsEndpoint();
    const endpointURL = new URL(endpoint);
    const port = endpointURL.port;

    // 运行 Lighthouse 分析
    const lighthouseConfig = {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance'],
        throttling: {
          cpuSlowdownMultiplier: config.throttleSettings.cpuSlowdownMultiplier,
          rttMs: config.throttleSettings.rttMs,
          throughputKbps: config.throttleSettings.throughputKbps,
        },
      },
    };
    const result = await lighthouse(task.url, { port }, lighthouseConfig);
    const lhr = result.lhr;

    // 获取 Lighthouse 得分和 Web Vitals 指标
    const score = lhr.categories.performance.score * 100;
    const webVitals = {
      LCP: lhr.audits['largest-contentful-paint'].numericValue,
      INP: lhr.audits['interactive'].numericValue,
      CLS: lhr.audits['cumulative-layout-shift'].numericValue,
      FCP: lhr.audits['first-contentful-paint'].numericValue,
      TBT: lhr.audits['total-blocking-time'].numericValue,
      FID: lhr.audits['max-potential-fid'].numericValue,
      TTI: lhr.audits['interactive'].numericValue,
    };

    // 保存尾帧截图
    const screenshotPath = `last-frame-${task.key}.png`;
    await page.screenshot({ path: screenshotPath });
    console.log(`尾帧截图已保存为 ${screenshotPath}`);

    // 保存分析结果
    results.push({
      url: task.url,
      title: task.title,
      score,
      webVitals,
      screenshotPath,
      key: task.key,
    });
  }

  // 关闭 Puppeteer
  await browser.close();

  // 处理分析结果
  const reportData = [];
  const createAt = new Date();
  for (const { url, title, score, webVitals, screenshotPath, key } of results) {
    reportData.push({
      key,
      title,
      url,
      score,
      webVitals,
      screenshotPath,
      createAt,
    });
  }

  // 将最终的 JSON 数据写入磁盘
  await fs.writeFile(
    resolve(process.cwd(), 'report.json'),
    JSON.stringify(reportData, null, 2),
    'utf-8',
  );

  // 输出文件名
  console.log('##[set-output json=report.json]\n');
}

// 运行任务
runTasks().catch(console.error);

// **并行
// 借助 Docker，我可以在镜像构建阶段将 Chromium、Node.js、Whistle、Lighthouse 模块、跑分脚本等等组成部分全部都预装好，然后定义自动化工具希望接收的参数（比如上面说的 Config 文件、Cookies 等等），这样一来，我只需要实例化不同的容器，传入不同的配置文件，就可以进行并行的跑分了。

// 想用就用，不用申请任何机器，不会收到任何告警和安全工单

// 自动化工具和输入配置、输出产物完全解藕，使用者只需提供配置就可以接受输出的 Lighthouse 报告

// 可以很自然地集成在已有的研发流程中，也可以单独部署 / 独立运行

// 核心思想
// 插件化：将自动化跑分脚本封装成一个 Docker 容器，使其可以作为 Orange-CI 的插件运行。
// 环境变量传递：从 process.env 接收传入插件的环境变量，如 Cookies 文件路径和任务配置文件路径。
// 结果输出：在 stdout 环境中输出 ##[set-output key=value] 的形式，将结果输出到流水线的环境变量中。
// 工作目录：插件容器运行时的 WORKDIR 是调用方的 $pwd，即当前工作目录。
// 独立获取 Cookies：将 Cookies 获取和跑分过程独立开来，使得不同业务可以有不同的票据获取方式。

// docker build -t auto-lighthouse:latest .
// docker run -v $(pwd)/tasks.yaml:/data/workspace/tasks.yaml -v $(pwd)/cookies.json:/data/workspace/cookies.json -v $(pwd)/output:/data/workspace/output -e CONFIG_PATH=/data/workspace/tasks.yaml -e COOKIES_PATH=/data/workspace/cookies.json auto-lighthouse:latest

// 用 Bash 开发镜像插件
// 用 Bash 开发一个镜像插件
// 在一节，我们将会学习如何使用 Bash 从零开发一个镜像插件。 这个插件的功能是打印 hello world。 这篇内容应该可以给你未来如何创作一个自己的插件提供一个清晰的思路。 我们这里假设你已经知道 Docker 的一些基本知识。

// 设计插件
// 第一步应该是去设计插件所需要的参数都有哪些，hello world 插件应该需要以下几个参数：

// text: 要输出到控制台的文本内容
// master:
//   push:
//     - stages:
//         - name: hello world
//           image: orangeci/hello-world
//           settings:
//             text: hello world
// 这些入参将会以环境变量的形式传给容器，不同的是，他们将会变成大写而且会辅以 PLUGIN_ 的前缀。

// 上面的入参将会转化为如下环境变量：

// PLUGIN_TEXT="hello world"
// 支持的参数类型
// 参数类型支持字符串、数值、布尔值、一维数组，其中数组在传给容器时将会以英文逗号 , 分割，比如：

// master:
//   push:
//     - stages:
//         - name: hello world
//           image: orangeci/hello-world
//           settings:
//             text:
//               - hello
//               - world
// 这个数组参数值将会转化为：

// PLUGIN_TEXT="hello,world"
// 特别复杂的参数值应该存在一个文件之中，在插件运行时加载。 如果你遇到参数值异常复杂的情况，往往不是格式能解决的，应当简化这些参数值，或者将他们做成多个插件。

// 书写脚本
// 下一步应该写一个可以打印 hello world 的Bash 脚本，如下：

// #!/bin/sh
// echo "$PLUGIN_TEXT"
// 构建插件镜像
// 插件将会被打包成 Docker 镜像进行分发使用。 因此需要创建一个 Dockerfile 把我们之前写好的脚本打包进去， 并且把它设置为 Entrypoint (opens new window)。

// FROM alpine

// ADD entrypoint.sh /bin/
// RUN chmod +x /bin/entrypoint.sh

// ENTRYPOINT /bin/entrypoint.sh
// 构建你的镜像:

// docker build -t orangeci/hello-world .
// 测试插件
// 你应该在本地测试好你的插件能够正常工作，可以使用 docker run 来运行插件，并且把参数通过环境变量的方式传进去：

// docker run --rm \
//   -e PLUGIN_TEXT="hello world" \
//   orangeci/hello-world
// 测试文件系统读取
// 插件有读取你构建流程工作区目录的权限，它会默认把构建的目录映射到插件的某个目录，然后把这个目录设置为工作区：

// docker run --rm \
//   -e PLUGIN_TEXT="hello world" \
//   -v $(pwd):$(pwd) \
//   -w $(pwd) \
//   orangeci/hello-world
// 返回变量
// 如果插件执行完后，需要返回变量并导出，可以参考 exports

// 发布插件
// 插件是一个 Docker 镜像，所以发布一个插件，就意味着需要把镜像发布到一个镜像源。

// 对于全球可用的插件，建议发布到 docker hub (opens new window)。

// 对于仅企业内部可用的插件，建议发布到企业内部私有的 Docker Registry。

// 发布镜像
// docker push orangeci/hello-world
// 如果你觉得制作的镜像可以被更多人使用， 可以通过 publish (opens new window)显示到镜像插件市场上。