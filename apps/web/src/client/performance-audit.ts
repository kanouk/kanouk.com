// Opt-in, local console diagnostics for reproducible browser QA. No network sink.
export function startPerformanceAudit() {
 if (!new URLSearchParams(location.search).has('perf-audit')) return;
 const root = document.documentElement;
 if (root.dataset.performanceAudit) return;
 root.dataset.performanceAudit='true';
 let longTasks=0;
 try { new PerformanceObserver(list=>{longTasks+=list.getEntries().reduce((sum,e)=>sum+e.duration,0);}).observe({type:'longtask',buffered:true}); } catch {}
 const report=()=>{
  const nav=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const resources=performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const api=resources.filter(r=>new URL(r.name).pathname.startsWith('/_emdash/api/'));
  console.info('yohaku-performance',JSON.stringify({
   ttfb:Math.round(nav?.responseStart??0),dcl:Math.round(nav?.domContentLoadedEventEnd??0),
   bytes:resources.reduce((sum,r)=>sum+r.transferSize,0),requests:resources.length,
   apiRequests:api.length,apiMaxMs:Math.round(Math.max(0,...api.map(r=>r.duration))),
   longTasksMs:Math.round(longTasks),images:document.images.length,
   organizerReady:document.querySelector('[data-organizer-ready="true"]')!==null,
   marks:performance.getEntriesByType('measure').filter(e=>e.name.startsWith('yohaku:')).map(e=>({name:e.name,ms:Math.round(e.duration)})),
  }));
 };
 window.addEventListener('load',()=>setTimeout(report,1500),{once:true});
 const timer=setInterval(report,3000);
 setTimeout(()=>clearInterval(timer),60000);
}
