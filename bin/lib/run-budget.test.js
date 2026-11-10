'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createRunBudget} = require('./run-budget');
function fixture() { let t=0; const b=createRunBudget({clock:()=>t,runStart:0,totalLimitMs:900000,stopReserveMs:180000,watchLimitMs:600000}); return {b,set:x=>{t=x}}; }
test('600-second watch cutoff is distinct from 15-minute run limit',()=>{const {b,set}=fixture();set(100000);b.startStimulus();set(699999);assert.equal(b.watchDecision().allow,true);set(700000);assert.equal(b.watchDecision().allow,false);assert.equal(b.snapshot().totalExceeded,false);});
test('preflight consumes total budget and reserves stop/save before watch cutoff',()=>{const {b,set}=fixture();set(500000);b.startStimulus();set(719999);assert.equal(b.watchDecision().allow,true);set(720000);assert.equal(b.watchDecision().allow,false);assert.equal(b.snapshot().totalRemaining,180000);});
test('do not start an operation that cannot finish before reserve',()=>{const {b,set}=fixture();set(500000);b.startStimulus();set(700000);assert.equal(b.watchDecision(25000).allow,false);assert.equal(b.watchDecision(19000).allow,true);});
test('slow save can exceed total: report it, never pretend success or kill',()=>{const {b,set}=fixture();set(500000);b.startStimulus();set(720000);assert.equal(b.watchDecision().allow,false);set(900001);assert.equal(b.snapshot().totalExceeded,true);assert.equal(b.snapshot().totalRemaining,0);});
test('invalid configuration fails closed',()=>{assert.throws(()=>createRunBudget({clock:()=>0,runStart:0,totalLimitMs:100,stopReserveMs:100,watchLimitMs:10}));});
