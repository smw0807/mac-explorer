const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function record(value, fields) {
  assert(isPlainObject(value), '일반 객체를 전달해야 합니다.');
  assert(Object.keys(value).every((key) => Object.hasOwn(fields, key)), '허용되지 않은 옵션입니다.');
  for (const [key, check] of Object.entries(fields)) check(value[key]);
}

const optional = (check) => (value) => { if (value !== undefined) check(value); };
const string = (value) => assert(typeof value === 'string', '문자열을 전달해야 합니다.');
const boolean = (value) => assert(typeof value === 'boolean', '참 또는 거짓을 전달해야 합니다.');
const integer = (min, max) => (value) => assert(Number.isSafeInteger(value) && value >= min && value <= max,
  `${min}~${max} 범위의 정수를 전달해야 합니다.`);
const text = (max, empty = false) => (value) => {
  string(value);
  assert((empty || value.length > 0) && value.length <= max && !value.includes('\0'), '문자열 길이나 내용이 올바르지 않습니다.');
};

function absolutePath(value) {
  text(32768)(value);
  assert(path.isAbsolute(value), '절대 경로를 전달해야 합니다.');
}

function fileName(value) {
  text(4096)(value);
  assert(value !== '.' && value !== '..' && !value.includes('/'), '파일 이름에 경로를 포함할 수 없습니다.');
}

const list = (check, min = 1, max = 65536) => (value) => {
  assert(Array.isArray(value) && value.length >= min && value.length <= max, '목록의 크기가 올바르지 않습니다.');
  for (const item of value) check(item);
};
const paths = list(absolutePath);
const conflict = (value) => assert(['keepBoth', 'overwrite', 'skip'].includes(value), '충돌 처리 방식이 올바르지 않습니다.');
const transferOptions = (moving) => optional((value) => record(value, {
  conflict: optional(conflict), ...(moving ? { name: optional(fileName) } : {}),
}));
const searchOptions = (recursive) => optional((value) => record(value, {
  showHidden: optional(boolean),
  ...(recursive ? { maxResults: optional(integer(1, 5000)), maxDepth: optional(integer(0, 64)) } : {}),
}));

const favorite = (value) => record(value, { path: absolutePath, name: text(4096), icon: text(128) });
const tab = (value) => record(value, { paths: list(absolutePath, 1, 2), dual: boolean });
const session = (value) => record(value, {
  tabs: list(tab, 0, 2000), active: integer(0, 1999), showHidden: boolean,
});

function validateSettingsPatch(value) {
  record(value, { favorites: optional(list(favorite, 0, 2000)), session: optional(session) });
}

const schemas = {
  'fs:readDir': [absolutePath],
  'fs:specialDirs': [],
  'fs:copy': [paths, absolutePath, transferOptions(false)],
  'fs:copyStart': [paths, absolutePath, transferOptions(false)],
  'fs:move': [paths, absolutePath, transferOptions(true)],
  'fs:conflicts': [paths, absolutePath],
  'ui:confirmConflict': [list(fileName)],
  'fs:trash': [paths],
  'fs:rename': [absolutePath, fileName],
  'fs:undo': [text(128)],
  'fs:undoRelease': [list(text(128), 0, 65536)],
  'fs:mkdir': [absolutePath, optional(fileName)],
  'fs:newFile': [absolutePath, optional(fileName)],
  'fs:fileIcon': [absolutePath],
  'fs:open': [absolutePath],
  'fs:reveal': [absolutePath],
  'fs:quickLook': [absolutePath],
  'ui:pickApp': [],
  'fs:openWithApp': [absolutePath, absolutePath],
  'fs:readText': [absolutePath, optional(integer(1, 1024 * 1024))],
  'fs:statfs': [absolutePath],
  'fs:exists': [absolutePath],
  'fs:compress': [paths],
  'fs:extract': [absolutePath],
  'fs:search': [absolutePath, text(4096, true), searchOptions(true)],
  'fs:searchSpotlight': [absolutePath, text(4096, true), searchOptions(false)],
  'clipboard:writeText': [string],
  'settings:get': [],
  'settings:set': [validateSettingsPatch],
  'fs:copyCancel': [integer(1, Number.MAX_SAFE_INTEGER)],
  'fs:watch': [text(128), absolutePath],
  'fs:unwatch': [text(128)],
};

function validateArguments(channel, args) {
  const schema = schemas[channel];
  assert(schema && args.length <= schema.length, '허용되지 않은 IPC 요청입니다.');
  schema.forEach((check, index) => check(args[index]));
  if (channel === 'fs:move' && args[2]?.name !== undefined) {
    assert(args[0].length === 1, '이름을 지정한 이동은 한 항목에만 사용할 수 있습니다.');
  }
}

function validateSender(event, appURL) {
  assert(event?.senderFrame && event.senderFrame === event.sender?.mainFrame
    && event.senderFrame.url === appURL && !event.sender.isDestroyed(), '신뢰할 수 없는 화면의 요청입니다.');
}

module.exports = { absolutePath, fileName, isPlainObject, validateSettingsPatch, validateArguments, validateSender };
