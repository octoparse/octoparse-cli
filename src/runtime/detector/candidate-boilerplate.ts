export function isStrongLegalBoilerplateText(value: string): boolean {
  return /ICP|ICP备|icp|公网安备|备案号?|网站备案|beian|营业执照|增值电信|网络文化经营|网械平台备|互联网药品信息服务|copyright|©|all rights reserved/i.test(value);
}

export function isLegalBoilerplateText(value: string): boolean {
  return isStrongLegalBoilerplateText(value)
    || /privacy policy|terms of (use|service)|隐私政策|用户协议|使用条款|儿童\/青少年个人信息保护规则/i.test(value);
}

export function isWeakBoilerplateText(value: string): boolean {
  return /about\s+baidu|百度首页|使用百度前必读|意见反馈|帮助中心|隐私|条款|关于我们|联系我们|帮助中心|客服|登录|注册|创作中心|业务合作/i.test(value);
}

export function isFooterLikeSelector(value: string): boolean {
  return /(footer|bottom|copyright|beian|icp|contentinfo|record|filing)/i.test(value);
}
