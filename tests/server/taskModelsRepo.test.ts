import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/server/db/client';
import { aiTasks, taskModels } from '../../src/server/db/schema';
import {
  addTaskModel,
  allTaskModelsRetired,
  listTaskModels,
  recordTaskFailure,
  recordTaskSuccess,
  removeTaskModel,
  reorderTaskModels,
  retireModelEverywhere,
  reviveTask,
  selectTaskCandidates,
  setTaskModelUpstream,
} from '../../src/server/db/repositories/taskModelsRepo';
import { reasoningEffortFor, setReasoningEffort } from '../../src/server/db/repositories/aiTasksRepo';
import { BUILT_IN_AI_TASKS, DEFAULT_CHAT_MODEL, DEFAULT_UPSTREAM } from '../../src/shared/aiTasks';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

const models = (task: string) => listTaskModels(task).map((entry) => entry.model);

describe('the lists a fresh database starts with', () => {
  it('gives every built-in task the default model, pinned to DeepSeek', () => {
    for (const task of BUILT_IN_AI_TASKS) {
      expect(listTaskModels(task.id)).toEqual([
        expect.objectContaining({ model: DEFAULT_CHAT_MODEL, upstream: DEFAULT_UPSTREAM, retired: false }),
      ]);
    }
  });
});

describe('a task list', () => {
  beforeEach(() => {
    db.delete(taskModels).run();
    db.delete(aiTasks).run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('adds new models at the bottom, as the last fallback', () => {
    addTaskModel('reply', 'a/first', 'deepseek');
    addTaskModel('reply', 'b/second', '');
    addTaskModel('reply', 'c/third', '');
    expect(models('reply')).toEqual(['a/first', 'b/second', 'c/third']);
  });

  it('only changes the pin when a model already on the list is added again', () => {
    addTaskModel('reply', 'a/first', 'deepseek');
    addTaskModel('reply', 'b/second', '');
    addTaskModel('reply', 'a/first', 'fireworks');
    expect(listTaskModels('reply').map((entry) => [entry.model, entry.upstream]))
      .toEqual([['a/first', 'fireworks'], ['b/second', '']]);
    expect(setTaskModelUpstream('reply', 'b/second', 'deepseek')).toBe(true);
    expect(setTaskModelUpstream('reply', 'nobody/nothing', 'deepseek')).toBe(false);
  });

  it('saves a drag-and-drop order and removes models', () => {
    for (const model of ['a/first', 'b/second', 'c/third']) addTaskModel('reply', model, '');
    expect(reorderTaskModels('reply', ['c/third', 'a/first', 'b/second']).map((entry) => entry.model))
      .toEqual(['c/third', 'a/first', 'b/second']);
    expect(removeTaskModel('reply', 'a/first')).toBe(true);
    expect(removeTaskModel('reply', 'a/first')).toBe(false);
    expect(models('reply')).toEqual(['c/third', 'b/second']);
  });

  it('rests a row after repeated failures, and a success clears the count', () => {
    addTaskModel('reply', 'a/first', '');
    for (let failure = 1; failure < DEFAULT_SETTINGS.modelFailureThreshold; failure += 1) {
      expect(recordTaskFailure('reply', 'a/first', '503')).toBe(false);
    }
    recordTaskSuccess('reply', 'a/first');
    expect(listTaskModels('reply')[0].consecutiveFailures).toBe(0);
    for (let failure = 1; failure < DEFAULT_SETTINGS.modelFailureThreshold; failure += 1) recordTaskFailure('reply', 'a/first', '503');
    expect(recordTaskFailure('reply', 'a/first', '503')).toBe(true);
    expect(listTaskModels('reply')[0].restingUntil).toBeGreaterThan(Date.now());
  });

  it('keeps lists apart: a model resting on one is still fine on another', () => {
    addTaskModel('reply', 'a/first', '');
    addTaskModel('factExtraction', 'a/first', '');
    for (let failure = 0; failure < DEFAULT_SETTINGS.modelFailureThreshold; failure += 1) recordTaskFailure('reply', 'a/first', '503');
    expect(listTaskModels('factExtraction')[0]).toMatchObject({ consecutiveFailures: 0, restingUntil: null });
  });

  it('skips resting and retired models, and brings resting ones back rather than having nothing', () => {
    addTaskModel('reply', 'a/first', '');
    addTaskModel('reply', 'b/second', '');
    addTaskModel('reply', 'c/third', '');
    for (let failure = 0; failure < DEFAULT_SETTINGS.modelFailureThreshold; failure += 1) recordTaskFailure('reply', 'a/first', '503');
    retireModelEverywhere('c/third', '400 not a valid model ID');
    expect(selectTaskCandidates('reply').map((entry) => entry.model)).toEqual(['b/second']);

    removeTaskModel('reply', 'b/second');
    // Only the resting one is left, so it comes back; the retired one never does.
    expect(selectTaskCandidates('reply').map((entry) => entry.model)).toEqual(['a/first']);
  });

  it('retires a model on every list at once, and Reset errors lifts it for one list only', () => {
    addTaskModel('reply', 'a/first', '');
    addTaskModel('topicExtraction', 'a/first', '');
    retireModelEverywhere('a/first', '400 not a valid model ID');
    expect(allTaskModelsRetired('reply')).toBe(true);
    expect(allTaskModelsRetired('topicExtraction')).toBe(true);
    expect(selectTaskCandidates('reply')).toEqual([]);

    reviveTask('reply');
    expect(listTaskModels('reply')[0]).toMatchObject({ retired: false, lastError: null });
    expect(listTaskModels('topicExtraction')[0].retired).toBe(true);
  });

  it('is not all-retired when it is empty', () => {
    expect(allTaskModelsRetired('reply')).toBe(false);
  });
});

describe('reasoning effort', () => {
  beforeEach(() => {
    db.delete(aiTasks).run();
  });

  it('defaults to none, and remembers what is set', () => {
    expect(reasoningEffortFor('reply')).toBe('none');
    setReasoningEffort('reply', 'low');
    setReasoningEffort('reply', 'high');
    expect(reasoningEffortFor('reply')).toBe('high');
  });

  it('treats an unrecognised stored value as none', () => {
    db.insert(aiTasks).values({ task: 'reply', reasoningEffort: 'extreme', updatedAt: Date.now() }).run();
    expect(reasoningEffortFor('reply')).toBe('none');
  });
});
