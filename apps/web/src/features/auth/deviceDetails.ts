export function deviceDetails(agent: string | null | undefined) {
  const ua = agent || '';
  const browser = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ] as const;
  const detected = browser.find(([, pattern]) => pattern.test(ua));
  const version = detected?.[1].exec(ua)?.[1].split('.')[0];
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '';
  return {
    title: detected
      ? `${detected[0]}${version ? ` ${version}` : ''}${os ? ` · ${os}` : ''}`
      : ua || '未知设备',
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua),
  };
}
