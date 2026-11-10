'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {confirmedSave}=require('./save-receipt');
test('only explicit successful business receipt permits confirmed save',()=>{
 assert.equal(confirmedSave({ok:true,out:'{"success":true,"data":{"ok":true}}'}),true);
 for(const r of [null,{ok:false,out:''},{ok:true,out:''},{ok:true,out:'{}'}, {ok:true,out:'{"success":false,"data":{"ok":true}}'}, {ok:true,out:'{"success":true,"data":{"ok":false}}'}]) assert.equal(confirmedSave(r),false);
});
