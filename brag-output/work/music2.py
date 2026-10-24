S='/tmp/claude-0/-home-user-survey/b0a51b09-f0aa-5f74-923e-ca9ecabaafd6/scratchpad'
import numpy as np, json, wave
sr=44100; T=20.0; N=int(sr*T)
L=np.zeros(N); R=np.zeros(N)
rng=np.random.default_rng(7)
def add(sig,t,pan=0.0,g=1.0):
    i=int(t*sr); n=min(len(sig),N-i)
    if n<=0: return
    L[i:i+n]+=sig[:n]*g*(1-max(pan,0)); R[i:i+n]+=sig[:n]*g*(1+min(pan,0))
def env(n,a=.005,d=.2):
    t=np.arange(n)/sr; e=np.minimum(t/a,1)*np.exp(-t/d); return e
def f(m): return 440*2**((m-69)/12)
def lp(x,fc):
    a=np.exp(-2*np.pi*fc/sr); y=np.zeros_like(x); p=0
    for i in range(len(x)): p=(1-a)*x[i]+a*p; y[i]=p
    return y
def lp_fast(x,fc):
    from numpy.fft import rfft,irfft
    X=rfft(x); fr=np.fft.rfftfreq(len(x),1/sr); X*=1/(1+(fr/fc)**4); return irfft(X,len(x))
# chords (midi): root, triad above
ch=[(45,[57,60,64]),(41,[53,57,60]),(48,[60,64,67]),(43,[55,59,62])]
bar=2.0
def chord(b): return ch[b%4]
# pad
for b in range(10):
    r,tri=chord(b); n=int(sr*(bar+0.4)); t=np.arange(n)/sr
    sig=sum(np.sin(2*np.pi*f(m)*t)+0.4*np.sin(2*np.pi*f(m)*2*t+1) for m in tri)/6
    sig=lp_fast(sig,1800)
    e=np.minimum(t/0.5,1)*np.minimum((bar+0.4-t)/0.5,1)
    g=0.5 if b<2 else 0.4
    add(sig*e,b*bar,0,g)
# pluck arpeggio, 8ths
for k in range(int(T/0.5)):
    t0=k*0.5
    if t0>=19.0: break
    b=int(t0//bar); r,tri=chord(b); notes=[tri[0]+12,tri[1]+12,tri[2]+12,tri[1]+12]
    m=notes[k%4]; n=int(sr*0.5); t=np.arange(n)/sr
    sig=(np.sin(2*np.pi*f(m)*t)+0.3*np.sin(2*np.pi*f(m)*2*t))*env(n,.003,.16)
    gain=0.22 if t0<4 else 0.17
    add(sig,t0,0.3*(1 if k%2 else -1),gain)
def kick():
    n=int(sr*0.35); t=np.arange(n)/sr
    fr=45+90*np.exp(-t/0.035); ph=2*np.pi*np.cumsum(fr)/sr
    return np.sin(ph)*np.exp(-t/0.11)
def hat():
    n=int(sr*0.08); x=rng.standard_normal(n); x=x-lp_fast(np.pad(x,(0,0)),6000)
    return x*np.exp(-np.arange(n)/sr/0.018)
def clap():
    n=int(sr*0.18); x=rng.standard_normal(n); x=lp_fast(x,3200)-lp_fast(x,900)
    return x*np.exp(-np.arange(n)/sr/0.05)
def bass(m,d):
    n=int(sr*d); t=np.arange(n)/sr; return np.sin(2*np.pi*f(m)*t)*np.minimum(t/0.01,1)*np.exp(-t/0.28)
# groove 4..17 (and light kick/bass to 18)
for k in range(int(4/0.5),int(16/0.5)):
    t0=k*0.5; b=int(t0//bar); r,_=chord(b)
    add(kick(),t0,0,0.55)
    add(hat(),t0+0.25,0.2,0.05)
    if (k%4) in (1,3): add(clap(),t0,0,0.11)
    add(bass(r-12 if r-12>=33 else r,0.5),t0,0,0.30)
    add(bass(r,0.25),t0+0.25,0,0.12) if k%2==0 else None
# intro: soft kick on beats of bar 2 only (t=2..4), muffled heartbeat
for k in range(4,8): add(kick(),k*0.5,0,0.22)
# cut whooshes ending on cuts
def whoosh(d=0.5,fc0=400,fc1=5000):
    n=int(sr*d); x=rng.standard_normal(n); t=np.arange(n)/sr
    y=np.zeros(n); seg=n//8
    out=np.zeros(n)
    for i in range(8):
        a=slice(i*seg,(i+1)*seg if i<7 else n)
        fc=fc0*(fc1/fc0)**(i/7); out[a]=lp_fast(x,fc)[a]
    return out*(t/d)**2*np.exp(-0*t)
for cut in (2.0,4.0,7.0,11.0,14.0,16.0):
    add(whoosh(0.5),cut-0.5,0.0,0.07)
# taps from log
log=json.load(open(S+'/work2/frames.json'))['log']
for e in log:
    t=round((e['a']+4)*4)/4
    n=int(sr*0.09); tt=np.arange(n)/sr
    tick=np.sin(2*np.pi*f(93)*tt)*np.exp(-tt/0.018)*0.5
    add(tick,t+0.03,0.1,0.10)
# impact at 4.0 & 16.0
def crash(d=1.6):
    n=int(sr*d); x=rng.standard_normal(n); x=x-lp_fast(x,5000); return x*np.exp(-np.arange(n)/sr/0.5)
add(crash(),4.0,0,0.07); add(crash(2.4),16.0,0,0.10)
add(kick(),16.0,0,0.7); 
# final stab chord
r,tri=chord(8)
for m in tri+[r+12]:
    n=int(sr*3.0); t=np.arange(n)/sr
    sig=(np.sin(2*np.pi*f(m)*t)+0.3*np.sin(2*np.pi*f(m)*2*t))*np.exp(-t/1.2)
    add(sig*np.minimum(t/0.005,1),16.0,0.1,0.10)
add(bass(45,3.0),16.0,0,0.35)
# master: fade in/out, limiter
fade=np.ones(N); fi=int(0.4*sr); fo=int(0.8*sr)
fade[:fi]=np.linspace(0,1,fi); fade[-fo:]=np.linspace(1,0,fo)
L*=fade; R*=fade
pk=max(np.abs(L).max(),np.abs(R).max()); sc=0.89/pk
L=np.tanh(L*sc*1.1)/np.tanh(1.1); R=np.tanh(R*sc*1.1)/np.tanh(1.1)
x=np.stack([L,R],1)
w=wave.open(S+'/work2/music.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
w.writeframes((x*32767*0.9).astype('<i2').tobytes()); w.close()
print('ok',np.abs(x).max())
