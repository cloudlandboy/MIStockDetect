const email = require('./email');
const goodsInfo = {
    name: ""
};
var buyLock = false;
var restryCount = 1;
var actionCount = 0;
var config;


async function start(browser, page) {
    if (!config) {
        throw new Error('请通过setConfig(Object)方法设置配置！');
    }
    await login(page);
    await goto(page, config.itemUrl, 'a[data-href^="//order.mi.com/site/login"]');
    await page.click('a[data-href^="//order.mi.com/site/login"]');
    await page.waitForTimeout(1500);
    let agree = await page.$('.el-dialog__footer .btn-primary');
    if (agree) {
        await agree.click();
        await page.waitForTimeout(1500);
    }

    console.log('开始尝试下单...');
    
    //选择选项,如果采用有库存的时候才选择选项来刷新按钮（可能会和默认的选项一致，那么就不会达到刷新按钮的目的）
    await optionSelect(page, config.options);

    const timer = setInterval(async () => {
        if (buyLock) { return; }
        if (restryCount > 5) {
            await stop(timer, browser);
            return;
        }
        try {
            if (await canBuy(page)) {
                buyLock = true;
                if (actionCount > -1) {
                    //刷新按钮
                    await refreshBtn(page, goodsInfo.optionInfo, config.options);
                }
                // clearInterval(timer);
                // return;
                await buy(page);
                await stop(timer, browser);
            } else {
                console.error("无货状态！");
            }
        } catch (error) {
            console.log("第" + restryCount + "次重试！");
            buyLock = false;
            restryCount++;
            await goto(page, config.itemUrl, '.option-box li');
            await optionSelect(page, config.options);
            console.log(error);
        } finally {
            actionCount++;
        }
    }, Math.max(config.interval * 1000, 50));
}

async function login(page) {
    await goto(page, config.loginUrl, 'input[name=account]');
    await page.type('input[name=account]', config.username, { delay: 100 });
    await page.type('input[name=password]', config.password, { delay: 100 });
    await page.click('button[type=submit]');
    await page.waitForTimeout(3000);
}

async function optionSelect(page, userOptions, batchIndex) {
    goodsInfo.optionInfo = await page.$$eval('.option-box', (options, userOptions) => {
        let optionInfo = { index: null, value: null, size: options.length, currentOptions: [] };
        for (let i = 0; i < options.length; i++) {

            let subOps = options[i].querySelectorAll('li');
            //获取选择大于1的，用于刷新按钮
            if (!optionInfo.index && subOps.length > 1) {
                optionInfo.index = i
                optionInfo.value = (userOptions[i] < subOps.length ? userOptions[i] + 1 : userOptions[i] - 1)
            };

            //获取当前选项
            for (let j = 0; j < subOps.length; j++) {
                if (Array.from(subOps[j].classList).includes('active')) {
                    optionInfo.currentOptions.push(j);
                }
            }
        }
        return optionInfo;
    }, userOptions)

    //选择参数
    // console.log('当前选项：' + goodsInfo.optionInfo.currentOptions);
    // console.log('用户选项：' + userOptions);
    for (let i = 0; i < goodsInfo.optionInfo.size; i++) {
        if (goodsInfo.optionInfo.currentOptions[i] != undefined && goodsInfo.optionInfo.currentOptions[i] == userOptions[i] - 1) {
            // console.log('跳过');
            continue;
        }
        //判断是否和默认相同，相同则无需选择
        await page.click(`.buy-option>.buy-box-child:nth-child(${i + 1}) li:nth-child(${userOptions[i]})`)
        //点击后的等待数据请求后
        await page.waitForResponse(res => res.url().startsWith('https://api2.order.mi.com/product/delivery') && res.status() == 200);
    }

    //选择套餐
    if (batchIndex) {
        try {
            await page.click(`.batch-box li:nth-child(${batchIndex - 1})`);
        } catch (e) {
            console.log('没有套餐可以选择！');
        }
    }
}

async function goto(page, url, waitForSelector) {
    await page.goto(url);
    await page.waitForSelector(waitForSelector);
};

async function refreshBtn(page, optionInfo, userOptions) {
    if (!optionInfo.index) {
        //说明所有都是一个选项，只能刷新页面
        await page.reload();
    } else {
        //点击别的
        await page.$$eval('.option-box', (options, optionInfo) => {
            options[optionInfo.index].querySelectorAll('li')[optionInfo.value - 1].click();
        }, optionInfo);

        await page.waitForResponse(response => response.url().startsWith('https://api2.order.mi.com/product/delivery') && response.status() === 200);
        //点击回来
        await optionSelect(page, userOptions);
    }
    await page.waitForSelector('.sale-btn a');
}

async function buy(page) {
    //加入购物车
    await Promise.all([
        page.waitForNavigation(),
        page.click('.sale-btn a')
    ]);
    console.log('加入购物车成功！');

    // throw new Error('测试出错');
    //获取商品名
    goodsInfo.name = await page.$eval('.goods-info>.name', el => el.innerText);

    //去购物车结算
    await Promise.all([
        page.waitForNavigation(),
        page.click('.actions>.btn-primary')
    ]);
    console.log('去购物车结算！');

    //去结算，会把全部结算，最好购物车只有一件商品

    //删除类名，不删除无头模式找不到元素
    await page.$eval('.cart-bar', el => el.classList.remove('cart-bar-fixed'));
    await Promise.all([
        page.waitForNavigation(),
        page.click('.cart-bar .btn-primary')
    ]);
    console.log('去结算！');

    //选择收货地址（第一个）
    await page.click('.address-item');

    //点击下单
    await Promise.all([
        page.waitForNavigation(),
        page.click('.operating-button>.btn-primary')
    ]);
    let pay_time = await page.$eval('.pay-time-tip', el => el.textContent);
    console.log("下单成功！请在" + pay_time + "内手动支付!");

    //发送邮件
    email(goodsInfo.name, pay_time).catch(console.error);
}

async function canBuy(page) {
    return await page.evaluate((goodsId, api) => {
        return new Promise((resolve, reject) => {
            fetch(api)
                .then(res => res.json()).then(json => {
                    resolve(json.data.first_datas[goodsId].stock_num > 0);
                }).catch(() => reject())
        })
    }, config.goodsId, config.itemQueryApiPre + config.goodsId + config.itemQueryApiParam + Math.round(new Date() / 1000));
}

function countDown(startTime) {
    const dayms = 1000 * 60 * 60 * 24;
    const hms = 1000 * 60 * 60;
    const mms = 1000 * 60;
    const startDate = new Date(startTime);
    const action = setInterval(() => {
        let timeDiff = startDate - new Date();
        let day = Math.floor(timeDiff / dayms)
        let hour = Math.floor(timeDiff % dayms / hms)
        let minu = Math.floor(timeDiff % dayms % hms / mms)
        let secon = Math.floor(timeDiff % dayms % hms % mms / 1000)
        let res = day + hour + minu + secon;
        console.clear();
        console.log('距离：' + startTime.replace('T', ' ') + ' 还有：' + day + '天' + hour + '小时' + minu + '分钟' + secon + '秒')
        if (res <= 0) {
            clearInterval(action);
        }
    }, 1000)
}

async function stop(timer, browser) {
    clearInterval(timer);
    await browser.close();
}

function setConfig(conf) {
    config = conf;
}

exports.start = start;
exports.setConfig = setConfig;
exports.countDown = countDown;