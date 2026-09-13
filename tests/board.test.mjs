// 棋盘点击命中测试。
// 回归重点：手机等窄屏下 .board-scale 会被 scale(k) 缩放，如果缩放比丢失（退化成 1），
// 点击坐标就会被算到左上方向偏掉，导致"点了没反应"。见 public/js/board.js 的 boardMetrics()。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hitTest, BOARD_SIZE } from '../public/js/board.js';

const { cell, margin } = BOARD_SIZE;

function layoutCenter(index) {
  return {
    x: margin + (index % 9) * cell,
    y: margin + ((index / 9) | 0) * cell,
  };
}

/** 把某个格子中心的"未缩放坐标"换算成屏幕坐标 */
function toScreen(index, m) {
  const c = layoutCenter(index);
  return { x: m.left + c.x * m.k, y: m.top + c.y * m.k };
}

const SAMPLES = [0, 4, 8, 40, 64, 67, 80, 89];

test('k=1（桌面）时点击命中正确格子', () => {
  const m = { left: 0, top: 0, k: 1 };
  for (const idx of SAMPLES) {
    const p = toScreen(idx, m);
    assert.equal(hitTest(p.x, p.y, m), idx, 'idx=' + idx);
  }
});

test('k<1（手机缩放）时点击仍命中正确格子', () => {
  for (const k of [0.9, 0.6, 0.45, 0.32]) {
    const m = { left: 137, top: 88, k: k };
    for (const idx of SAMPLES) {
      const p = toScreen(idx, m);
      assert.equal(hitTest(p.x, p.y, m), idx, 'k=' + k + ' idx=' + idx);
    }
  }
});

test('回归：缩放比若退化成 1，手机端会点到错误格子', () => {
  const real = { left: 137, top: 88, k: 0.6 };
  const buggy = { left: 137, top: 88, k: 1 }; // 旧实现：.board-scale 宽高为 0 -> k 退化成 1
  const idx = 64; // (1,7) 红炮
  const p = toScreen(idx, real);

  assert.equal(hitTest(p.x, p.y, real), idx, '修好后应正确命中');
  assert.notEqual(hitTest(p.x, p.y, buggy), idx, '缩放丢失时应复现出错误结果');
});

test('棋盘外的点不命中任何格子', () => {
  const m = { left: 0, top: 0, k: 1 };
  assert.equal(hitTest(-80, -80, m), -1);
  assert.equal(hitTest(99999, 99999, m), -1);
  // 棋盘外框之外（margin 区域）
  assert.equal(hitTest(2, 2, m), -1);
});

test('缩放后相邻格子不会互相误判', () => {
  const m = { left: 20, top: 10, k: 0.5 };
  for (const idx of [30, 31, 39, 40, 41, 49]) {
    const p = toScreen(idx, m);
    assert.equal(hitTest(p.x, p.y, m), idx, 'idx=' + idx);
  }
});

test('缩放比缺失时按 1 处理且不抛异常', () => {
  const m = { left: 0, top: 0 };
  // k=1：lx=ly=100 -> cx=cy=1 -> 索引 1*9+1 = 10
  assert.equal(hitTest(100, 100, m), 10);
  assert.equal(typeof hitTest(100, 100, m), 'number');
});
