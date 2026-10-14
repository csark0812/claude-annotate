import re,sys
d=open(sys.argv[1],"rb").read().decode("utf8","replace")
d=re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?|\x1b[78]","",d)
n=int(sys.argv[2]) if len(sys.argv)>2 else 3000
print(d[-n:])
