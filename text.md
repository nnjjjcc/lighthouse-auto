手工操作 Lighthouse 跑分费时费力，如果要跑 100 个目标，重复 1000 次跑分，显然只靠手艺活是没法持续的；

Lighthouse 面板没法模拟 QQ 定制的 UserAgent，经常得不到有效的跑分数据；

不同的域名（或子域名）下的业务需要不同的登录票据，手工跑分需要先想办法去对应的子域名获取登录态；

Lighthouse 硬件参数模拟、网络环境模拟太“黑盒”，我更希望有可以量化的数据指标；

输出的结果太分散，没有有效的沉淀渠道，单个的数据也无法提供没有太高的防劣化参考价值。

在 Google 和 KM 里一阵徜徉后，发现社区和司内也没有类似的可以帮助我提前下班的工具或者基础设施，那么是时候自己撸一个自动化 Lighthouse 性能分析工具来解决问题了。

想要完整地从 0 到 1 跑通自动化 Lighthouse 性能分析的链路，我不得不解决下面的问题

跑分任务如何输入？

如何让 Lighthouse 自动跑分？

自动化的 Lighthouse 应该跑在哪？

如何处理跑分结果？

自动化 Lighthouse 工具怎么保证通用性和可复用？

维护跑分任务
对于跑分的目标，我们最关心的当然是他的线上链接，然而我们可能还希望他有一个人类可读的标题，来提示维护者“这个链接是啥”，我希望一个单一的跑分目标可以被这样简单定义:

interface Task {
	key: string;   // 标识这个任务的唯一性
	title: string; // 人类可读的标题
	url: string;   // 跑分的地址
}
之前在手工跑分时，我们遇到了一些问题比如说：UserAgent 模拟和 Cookies 的注入。起初我将这两点也作为一个跑分任务最小单元的定义组成部分，但实践中发现，我们可以让一整个任务列表复用同一个 UserAgent 和同一套 Cookies，需要不同的 UA 和登录态的任务可以拆分成不同的任务列表，从而让跑分的任务保持简单和通用。

遵循同样的设计逻辑，我们可以为一串任务列表指定相同的节流设置（网络延迟模拟、CPU 模拟等），于是乎一个完整的任务输入应该是这样的:

interface Config {
	taskList: Task[];
	userAgent: string;
	throttleSettings: ThrottleSettings;
	cookies: Cookies[];
	// ... 其他对于该任务列表通用的配置
}
接下来，我们只需要按照这样的形式来定义一个 YAML 文件或者 JSON 文件，就可以清晰的描述我们自动化跑分任务的目标和自定义配置了。

最终我选择了 YAML 来描述配置，因为 JSON 有一些多余的括号和引号会让我敲更多次键盘。

我们可以在一个代码仓库里维护很多个这样的配置文件，假设以后我们的自动化工具足够通用，就可以根据不同的配置文件并行地开启不同的自动化跑分过程。

Lighthouse 自动跑分
通过调研，我发现了 Lighthouse 提供了三种运行方式:

Chrome 开发者工具

Lighthouse CLI

Lighthouse Node.js 模块集成

综合考虑下，开发者工具手工操作显然不采纳，CLI 的方式虽然实现了“黑窗”的命令式调用，但仍然不够定制化和方便，所以采用 Lighthouse Node.js 模块是最容易实现自动化的方案。

简单的自动化过程其实也很容易实现：

遍历我们的任务配置

将通用配置和任务 URL 挨个传入 Lighthouse 模块

Promise.allSettled 等待运行全部结束

将输出的 JSON / HTML 结果返回

串行 or 并行
这里就遇到了第一个坑点：Lighthouse 必须串行执行，假如我们打开 Chrome，同时对多个页面跑 Lighthouse，最后就会发现没有一个页面成功跑出来正确的结果，比如:



解决这个问题的方案就是等待上一个跑分任务结束了再串行执行下一个任务，类似于在一个循环中 await 跑分任务。

可能你会想，那我起不同的进程去跑 Node.js 或者浏览器不可以吗，实践上看也不行，想要最准确的结果，就必须串行的执行。那前面我们说的“根据不同的配置文件并行地开启不同的自动化跑分过程” 要怎么实现呢？这里我们暂时不表，留给后面细说。

除此之外，我又遇到了另一个麻烦：业务获取不到登录态。

种植登录态
按照我的预想，Lighthouse 模块提供了接口可以注入 extraHeader，我把 Cookies 注入进 Headers 里不就有有登录态了嘛？这个问题也在 ChromeLauncher（Lighthouse 默认依赖的浏览器运行库）上发现了：github.com/GoogleChr...

最终我发现，给 Lighthouse 提供的 extraHeader 只是让 Lighthouse 每次发请求时都带上这个额外的 Header，而页面上并不是真的种上了Cookies，所以假如业务代码这么来判断是否登录就寄了:

const { cookie } = window.document;
return cookie.indexOf('p_skey') > -1; // 登录态的 Cookie name
换句话说，我们需要真的给浏览器种上页面需要的 Cookies 才行。

既然 Lighthouse 自带的 ChromeLauncher 提供的无头浏览器控制能力不够，那我们就自己提供无头浏览器。

熟悉 Node.js 的同学肯定知道 puppeteer 这个库，提供了一套还挺强大的 API 来让脚本实现浏览器的自动控制。那么借助 puppeteer，我们可以事先将所有需要的 Cookies 都种进无头浏览器里，然后将无头浏览器里交给 Lighthouse 去跑，这样 Lighthouse 所运行的页面自然而然可以拿到登录态票据了。

幸运的是 Lighthouse 确实提供了兼容 Puppeteer API 提供的 Page 协议的能力（看第 4 个参数）

/**
 * Run Lighthouse.
 * @param {string=} url The URL to test. Optional if running in auditMode.
 * @param {LH.Flags=} flags Optional settings for the Lighthouse run. If present,
 *   they will override any settings in the config.
 * @param {LH.Config=} config Configuration for the Lighthouse run. If
 *   not present, the default config is used.
 * @param {LH.Puppeteer.Page=} page
 * @return {Promise<LH.RunnerResult|undefined>}
 */
declare function lighthouse(url?: string | undefined, flags?: LH.Flags | undefined, config?: LH.Config | undefined, page?: LH.Puppeteer.Page | undefined): Promise<LH.RunnerResult | undefined>;
为 Lighthouse 准备好运行环境
结合上面说的，我们可以为 Lighthouse 准备好无头浏览器的运行环境:

种好 Cookies

模拟 UserAgent

模拟屏幕尺寸

禁用缓存

const page = await browser.newPage();

  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  if (url) {
    await page.goto(url, gotoOptions);
  }
  await page.setCacheEnabled(enableCache ?? false);

  if (cookies) {
    await page.setCookie(...cookies);
  }

  if (userAgent) {
    await page.setUserAgent(userAgent);
  }

  const realViewport = {
    width: viewport?.width || (mobile ? 375 : 1920),
    height: viewport?.height || (mobile ? 812 : 1080),
  };

  await page.setViewport(realViewport);
有了种植的方法，其实我们还没解决怎么自动获取的问题。

获取登录态
如何用歪门邪道获取登录票据并不是这里重点讨论的环节，但是有了无头浏览器，模拟用户登录行为获取登录态 Cookies 也不是一件难事。

可以使用我写好的插件来在流水线环境下获取登录态：csighub.tencentyun.com/ccweng/auto-lighthouse-qq-slogin:latest
使用文档：cdn-go.woa.com/ccwen...
没有上线的业务怎么跑
假如一个跑分目标，都还没正式上线，或者是新功能只在测试环境里怎么办呢？好像我们没办法拿到一个跑分的目标 URL。

为了解决这个问题，我们可以回想一下我们是怎么让测试同学连到测试环境进行验证的:

APISIX 染色

Nohost 配置代理转发规则

回到我们的 case，我们直接把 Nohost 搬到本地来开个代理不就行了。也就是说，我们在跑分的时候可以开一个 Whistle 代理，然后配置正式域名到测试环境 IP 的代理转发规则，同时让无头浏览器的流量都走代理服务器，这样就可以实现访问没有上线的业务了。

为了保持“自动化”的初心，这个过程最多只允许在跑分过程开始前传入一个代理配置文件，剩下的全部都由自动化工具来完成，这是可以实现的。

从 Whitsle 文档 中可以看到，Whistle 提供了 CLI 的模式来运行，比如添加代理规则只需要运行:

w2 add <代理规则文件地址>
# 或者
w2 use <代理规则文件地址>
Node.js 可以开一个 child_process 来执行命令，所以我们只需要让跑分工具的使用方传入代理配置文件路径，然后在子进程中启动代理服务器并添加到代理中就可以了。

简单封装一个 Promise 风格的 Shell 调用函数

import { exec } from 'child_process';

export default function callShell(command: string) {
  return new Promise<string>((resolve, reject) => {
    exec(command, (err, stdout) => {
      if (err) {
        console.error('Fail to callShell', err);
        reject(err);
      }
      resolve(stdout);
    });
  });
}
当识别到输入包含代理配置文件时，开启代理并添加规则:

if (whistleFile) {
    // 开启 whistle
    const [, whistleErr] = await tryCatch(callShell('w2 start -M "prod|capture"'));
    if (whistleErr) {
      console.log('❌ 开启 Whistle 代理失败');
      exit(1);
    }
    console.log('✅ 开启 Whistle 代理成功');
    // 添加 whistle 配置
    const [, proxyErr] = await tryCatch(callShell(`w2 use ${whistleFile} --force`));
    if (proxyErr) {
      console.log('❌ 添加 Whistle 配置失败');
      exit(1);
    }
  }
  const proxy = whistleFile ? 'http://127.0.0.1:8899' : undefined;
最后，在开启无头浏览器时，可以将 proxyServer 传入 args 中

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

return puppeteer.launch({
	args,
	ignoreHTTPSErrors: true,
	headless: true,
	timeout: 100000,
});
准备好跑分用的无头浏览器环境后，交给 Lighthouse 模块即可得到它输出的 JSON 报告了。

输出跑分数据
Lighthouse 模块的一次跑分任务中，会输出非常多的内容，我们需要挑选最关心的部分:

那个心心念念的 Lighthouse 得分

Web Vitals 的数据指标，比如：LCP、INP、CLS、FCP、TBT、FID、TTI 等等（这些指标的含义可以详见 Web Vitals）

尾帧截图：毕竟是无头浏览器跑的，我还是需要一点直观的图示来说明他是不是真的跑对目标了。

除此之外，Lighthouse 还会输出很多比如性能优化建议、指标数据解释等等内容，这些是具备参考价值的，但是在我刚开始实现 “Lighthouse 自动化” 这个目标时，还不太至关重要，所以我暂时先过滤来保持输出结果的简单。

因为 Lighthouse 输出的 JSON 报告还是比较大的，可以在每分析得到一个报告后就立刻写入磁盘 IO，然后将文件路径加入结果列表中，然后等待全部任务都 “settled” 了，再挨个读出、过滤数据、将我关心的数据加入最终的 JSON 中。

  const reportData = [];
  for (const { url, title, path, score, key } of results) {
    if (!path) {
      continue;
    }
    const json = JSON.parse(await readFile(path, { encoding: 'utf-8' }));
    const {
      firstContentfulPaint,
      largestContentfulPaint,
      interactive,
      speedIndex,
      totalBlockingTime,
      cumulativeLayoutShift,
      maxPotentialFID,
    } = json.audits.metrics.details?.items[0] || {};
    const screenshot = json.audits['final-screenshot'].details?.data;
    if (score) {
      reportData.push({
        key,
        title,
        url,
        score,
        firstContentfulPaint,
        largestContentfulPaint,
        interactive,
        speedIndex,
        totalBlockingTime,
        cumulativeLayoutShift,
        maxPotentialFID,
        screenshot,
        createAt,
      });
    }
  }
最后，再将最终的单一 JSON 写入磁盘 IO，将文件路径作为返回值，或者输出回环境变量（比如在 orange-ci 或者 Github Actions 中，可以在 stdout 环境中输出 ##[set-output key=value] 的形式来输出到流水线的环境变量中

await writeFile(
    resolve(process.cwd(), 'report.json'),
    JSON.stringify(reportData),
    'utf-8',
  );
// 输出文件名
console.log('##[set-output json=report.json]\n');
为了保持通用性和保持分析环节间的解藕，Lighthouse 自动化工具的任务到这里就结束了：输入一些配置 --> 跑跑跑 --> 输出一个结果文件。

自动化工具运行方式
对于一般的 Node.js 脚本，可能直接打包成可执行的制品上传到 NPM 库是个好的选择，使用的时候拉下来跑。但上面的过程涉及到了无头浏览器（Chromium）的安装、Whistle 代理的安装和启用等过程，想办法去一次性“准备好”所有环境是必须做的。

所以，用容器化的方式去集成自动化 Lighthouse 跑分脚本、Node.js 运行环境、Chromium、Whistle 网络代理等等工具是不错的选择。

Docker 容器化
借助 Docker，我可以在镜像构建阶段将 Chromium、Node.js、Whistle、Lighthouse 模块、跑分脚本等等组成部分全部都预装好，然后定义自动化工具希望接收的参数（比如上面说的 Config 文件、Cookies 等等），这样一来，我只需要实例化不同的容器，传入不同的配置文件，就可以进行并行的跑分了。

在容器化时，可能需要考虑一些问题:

Chromium 单独下载后，下载 puppeteer 时应跳过下载 Chromium

中文字体

为了让 puppeteer 可以正确识别到 Chromium，需要将 Chromium 的安装位置注入 PUPPETEER_EXECUTABLE_PATH 环境变量中

安装好全局包，比如 pnpm、whistle

集成 whistle.polaris 插件（支持通过代理规则改变寻址服务）

FROM node:18

WORKDIR /data/workspace/

COPY ./ ./

RUN apt-get update && \
  apt-get install -yq chromium fonts-wqy-zenhei && \
  fc-cache -vf && \
  export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true && \
  export PUPPETEER_SKIP_DOWNLOAD=true && \
  ln -s $(which chromium) /data/workspace/chromium && \
  npm install -g pnpm whistle && \
  w2 i @tencent/whistle.polaris && \
  pnpm install && \
  npx lerna run build --scope lighthouse-trigger

ENV PUPPETEER_EXECUTABLE_PATH /data/workspace/chromium

ENTRYPOINT [ "node", "/data/workspace/packages/trigger/dist/index.js" ]
容器化后，摆在我面前的可能有两条合适的路:

部署到 TKE 上，用 CronJob 定时跑；

在 orange-ci 流水线上指定 CronJob 定时触发；

一开始，我想都没想就申请了 TKE 资源部署上去跑了，然后就遇到了几个我不想面对的问题:

我必须把配置一起打包进跑分容器里，如果要更新配置就要更新镜像

TKE 时不时弹机器告警

安全扫描每天都警告我 Chromium 的安全漏洞

如果我要并行地跑很多份配置，我要对每份配置都打一个镜像部署成 CronJob

从通用化的角度来考虑，假如以后有别的开发同学也想跑这个自动化工具，如果他也需要：申请机器、把自动化 Lighthouse 的仓库拉下来改配置、修改构建流水线打出自己的镜像、更新 TKE 上的镜像... 这个过程显然充满了魔法和容易出错的地方，并且对于一个使用工具的人来说，平白无故会多出许多心智负担。

所以下一步，我开始思考如何将各个环节通用化起来。

通用化和 CI 集成
从使用者的角度，我会希望 Lighthouse 自动化工具尽可能的易用，可以让任何人没有心智负担地用:

想用就用，不用申请任何机器，不会收到任何告警和安全工单

自动化工具和输入配置、输出产物完全解藕，使用者只需提供配置就可以接受输出的 Lighthouse 报告

可以很自然地集成在已有的研发流程中，也可以单独部署 / 独立运行

既然如此，为什么不把自动化工具做成一个可以在 orange-ci 中运行的插件呢？

对照 orange-ci 的插件开发文档，可以很容易将脚本和容器改造成符合要求的插件：

从 process.env 接收传入插件的环境变量

在 stdout 环境中输出 ##[set-output key=value] 的形式来将结果输出到流水线的环境变量中

插件容器运行时的 WORKDIR 是调用方的 $pwd

假设使用方准备好了 Cookies 文件和任务配置文件，传入插件后，插件将跑分结果输出到使用方 $pwd 的某个文件中，然后将文件名输出告知使用方，这个事情就闭环了。

Cookies 的获取可能也是一个自动化的过程（比如上面说的自动登录 QQ），也可以在流水线环境里用插件自动获取输出的 Cookies 文件，但是不同业务的票据获取方式可能不那么相同，所以我希望将 Cookies 获取和跑分这两个过程独立开来。
将自动化跑分的过程插件化后，使用方可以维护一个专门放跑分配置的仓库或者目录，并且为仓库配置 orange-ci 定时流水线任务，比如:

- wework:
    title: "Lighthouse触发器"
    notify:
      - $ORANGE_BUILD_USER
  services:
    - docker
  stages:
    - name: 🤯 获取登录态
      image: csighub.tencentyun.com/ccweng/auto-lighthouse-qq-slogin:latest
      settings:
        # 测试账号
        uin: 1234567
        password: xxxxxx
      exports:
        output: COOKIES
    - name: 💡 运行 Lighthouse 自动化脚本
      image: csighub.tencentyun.com/ccweng/auto-lighthouse:latest
      settings:
        cookies: ${COOKIES}
        config: ./task.yml
      retry: 2
      exports:
        json: JSON_FILE
	# 生成了报告文件，路径是 ${JSON_FILE}，可以交给后面其他流水线步骤
假如使用方有许多不同的配置文件，比如 task.qzone.yml | task.ti.yml | task.other.yml，可以写成不同的流水线事件，然后在 .orange-ci.yml 中触发，因为 orange-ci:apply 默认是不等待 trigger 执行结束的，所以不同的事件执行起来是并行的:

# 定时任务
  "crontab: 0 * * * *":
    - stages:
      - name: 🚀 自动跑分-QZONE
        type: orange-ci:apply
        options:
          configFrom: ./.ci/.orange-ci.hourly-cronjob.yml
          event: api_trigger_cronjob_qzone
      - name: 🚀 自动跑分-TI
        type: orange-ci:apply
        options:
          configFrom: ./.ci/.orange-ci.hourly-cronjob.yml
          event: api_trigger_cronjob_ti
      - name: 🚀 自动跑分-OTHER
        type: orange-ci:apply
        options:
          configFrom: ./.ci/.orange-ci.hourly-cronjob.yml
          event: api_trigger_cronjob_other
通过定时任务的不断触发，就可以得到一连串指标数据样本，这时使用方就可以按需处理这些数据了。

结果输出与数据沉淀
在流水线的每次定时任务中，最终都会得到一个 report.json，记录了本次对配置目标 URL 列表的跑分结果，采集到原始数据后，可以想办法来实现数据持久化:

存进数据库里，方便以后查询或分析

将报告 JSON 通过流水线插件传到 CDN-GO

同样为了不维护服务、摆脱审批 / 告警的心智负担，我选择将输出的 JSON 按照约定格式上传内源 CDN 上。

具体来说，因为我设定了对小组 DAU Top 40 业务的每小时跑分流水线，所以可以用日期时间来标识跑分数据，比如约定了 /latest/qzone/2024080614/report.json 存放的是 qzone 域名下的 URL 在 2024 年 8 月 6 日 14 时的跑分结果。

然后我再设定一条每日 23:30 运行一次的流水线任务，使用 Node.js 拉取当天的所有跑分结果，然后对所有数据进行一些比如求和平均的操作，最终输出一个跑分日报。同样的原理，也可以得到跑分周报、跑分月报等等。

最后，用 Vue3 搭建了一个前端看板来查看每天、每小时的指标数据具体数值和变化趋势:





然后周会时就可以给优化到 90 分的业务负责人一个大拇哥 👍

假如某些时刻开始的跑分曲线突然下跌了，那有理由怀疑是发版本 / 功能更新等原因导致页面性能发生了劣化。

未来展望
从防劣化的角度上说，最好可以尽早发现问题，而对于正式环境的跑分可能存在滞后性，这也是我在自动化跑分容器中集成 Whistle 代理和 Polaris 插件的出发点：让跑“测试环境”成为可能，从而让自动化跑分可以从研发开始的阶段就开始执行。

我希望可以推进自动化 Lighthouse 性能分析在业务开发持续集成阶段中落地，比如对开发分支的测试环境持续跑分，及时发现引发劣化的版本时间，从而帮助开发同学判断劣化的原因并进行优化。

除此之外，我也希望在后续在防劣化和性能优化建议上持续完善一整个跑分链路，比如跑分指标数据接入 DataTalk 等数据分析平台，以及充分利用 Lighthouse 输出的性能优化建议和 AI 工具结合来提供具体的代码优化建议等等。

在未来，我期待自动化Lighthouse方案能够进一步集成到开发生命周期的每一个阶段，从代码编写到功能部署，为开发者提供实时的性能反馈，让性能不再是事后的补救，而是设计和开发的内在组成部分。随着 Web 开发技术和 AI 的不断发展，我相信 Web 性能优化一定能不断突破边界，让我们为用户交付的质量更硬的产品。