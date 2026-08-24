//+------------------------------------------------------------------+
//| RegimeXExec.mq5                                                  |
//| Thin execution EA — NO strategy logic.                           |
//|                                                                  |
//| Mailbox (relative to MQL5/Files):                                |
//|   regimex/commands/pending/*.json                                |
//|   regimex/commands/processing/*.json                             |
//|   regimex/replies/*.json                                         |
//|   regimex/events/*.json                                          |
//|                                                                  |
//| Ignore files whose names start with .tmp- (partial writes).      |
//| Never re-execute a command already in processing/.               |
//| Native ACCOUNT_TRADE_MODE is authoritative for DEMO/REAL.        |
//+------------------------------------------------------------------+
#property copyright "RegimeX"
#property version   "1.00"
#property strict

input string InpMailboxRoot = "regimex";
input string InpBridgeSecret = ""; // set in EA inputs; never commit
input long   InpMagic = 26082301;
input int    InpTimerMs = 200;

int g_unackedProcessing = 0;

string MailboxPath(string sub)
  {
   return InpMailboxRoot + "\\" + sub;
  }

bool IsTempName(string name)
  {
   return StringFind(name, ".tmp-") == 0;
  }

string JsonGetString(string json, string key)
  {
   string needle = "\"" + key + "\":";
   int p = StringFind(json, needle);
   if(p < 0)
      return "";
   p += StringLen(needle);
   while(p < StringLen(json) && StringGetCharacter(json, p) == ' ')
      p++;
   if(p < StringLen(json) && StringGetCharacter(json, p) == '"')
     {
      p++;
      int end = StringFind(json, "\"", p);
      if(end < 0)
         return "";
      return StringSubstr(json, p, end - p);
     }
   int end = p;
   while(end < StringLen(json))
     {
      int ch = StringGetCharacter(json, end);
      if(ch == ',' || ch == '}' || ch == ']')
         break;
      end++;
     }
   string raw = StringSubstr(json, p, end - p);
   StringTrimLeft(raw);
   StringTrimRight(raw);
   return raw;
  }

double JsonGetNumber(string json, string key, double fallback)
  {
   string s = JsonGetString(json, key);
   if(s == "" || s == "null")
      return fallback;
   return StringToDouble(s);
  }

bool JsonGetBool(string json, string key)
  {
   string s = JsonGetString(json, key);
   return (s == "true" || s == "1");
  }

void WriteReply(string requestId, string idempotencyKey, string command, bool ok, string errorCode, string errorMessage, string resultJson, bool needsReconcile)
  {
   string body = "{";
   body += "\"requestId\":\"" + requestId + "\",";
   body += "\"idempotencyKey\":\"" + idempotencyKey + "\",";
   body += "\"command\":\"" + command + "\",";
   body += "\"ok\":" + (ok ? "true" : "false") + ",";
   if(errorCode != "")
      body += "\"errorCode\":\"" + errorCode + "\",";
   if(errorMessage != "")
      body += "\"errorMessage\":\"" + errorMessage + "\",";
   body += "\"needsReconcile\":" + (needsReconcile ? "true" : "false") + ",";
   body += "\"createdAt\":\"" + TimeToString(TimeGMT(), TIME_DATE | TIME_SECONDS) + "\",";
   body += "\"authHmac\":\"\",";
   if(resultJson != "")
      body += "\"result\":" + resultJson;
   else
      body += "\"result\":null";
   body += "}";

   string tmp = MailboxPath("replies") + "\\.tmp-" + requestId + ".json";
   string dest = MailboxPath("replies") + "\\" + requestId + ".json";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
      return;
   FileWriteString(h, body);
   FileClose(h);
   FileMove(tmp, 0, dest, FILE_REWRITE);
  }

string TradeModeString()
  {
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode == ACCOUNT_TRADE_MODE_DEMO)
      return "DEMO";
   if(mode == ACCOUNT_TRADE_MODE_CONTEST)
      return "CONTEST";
   if(mode == ACCOUNT_TRADE_MODE_REAL)
      return "REAL";
   return "UNKNOWN";
  }

string MarginModeString()
  {
   long mode = AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   if(mode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
      return "HEDGING";
   if(mode == ACCOUNT_MARGIN_MODE_RETAIL_NETTING)
      return "NETTING";
   if(mode == ACCOUNT_MARGIN_MODE_EXCHANGE)
      return "EXCHANGE";
   return "UNKNOWN";
  }

string TradePermissionString(string symbol)
  {
   long mode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if(mode == SYMBOL_TRADE_MODE_DISABLED)
      return "DISABLED";
   if(mode == SYMBOL_TRADE_MODE_LONGONLY)
      return "LONGONLY";
   if(mode == SYMBOL_TRADE_MODE_SHORTONLY)
      return "SHORTONLY";
   if(mode == SYMBOL_TRADE_MODE_CLOSEONLY)
      return "CLOSEONLY";
   if(mode == SYMBOL_TRADE_MODE_FULL)
      return "FULL";
   return "UNKNOWN";
  }

string AccountJson()
  {
   string json = "{";
   json += "\"tradeMode\":\"" + TradeModeString() + "\",";
   json += "\"marginMode\":\"" + MarginModeString() + "\",";
   json += "\"login\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\",";
   json += "\"company\":\"" + AccountInfoString(ACCOUNT_COMPANY) + "\",";
   json += "\"server\":\"" + AccountInfoString(ACCOUNT_SERVER) + "\",";
   json += "\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\",";
   json += "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",";
   json += "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"floatingPnl\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2);
   json += "}";
   return json;
  }

string SymbolJson(string symbol)
  {
   string json = "{";
   json += "\"name\":\"" + symbol + "\",";
   json += "\"description\":\"" + SymbolInfoString(symbol, SYMBOL_DESCRIPTION) + "\",";
   json += "\"digits\":" + IntegerToString(SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + ",";
   json += "\"point\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_POINT), 8) + ",";
   json += "\"tickSize\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE), 8) + ",";
   json += "\"tickValue\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE), 8) + ",";
   json += "\"contractSize\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE), 8) + ",";
   json += "\"volumeMin\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN), 8) + ",";
   json += "\"volumeMax\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX), 8) + ",";
   json += "\"volumeStep\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP), 8) + ",";
   json += "\"tradeMode\":\"" + TradePermissionString(symbol) + "\",";
   json += "\"tradeAllowed\":" + (SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE) != SYMBOL_TRADE_MODE_DISABLED ? "true" : "false") + ",";
   uint fillingMask = (uint)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   ENUM_ORDER_TYPE_FILLING selectedFilling;
   SelectFillingMode(symbol, selectedFilling);
   json += "\"fillingModeMask\":" + IntegerToString((int)fillingMask) + ",";
   json += "\"fillingModes\":" + FillingModesJson(fillingMask) + ",";
   json += "\"selectedFillingMode\":\"" + SelectedFillingName(selectedFilling) + "\",";
   json += "\"fillingMode\":\"" + SelectedFillingName(selectedFilling) + "\",";
   json += "\"bid\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_BID), (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + ",";
   json += "\"ask\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_ASK), (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   json += "}";
   return json;
  }

string PositionJson(ulong ticket)
  {
   if(!PositionSelectByTicket(ticket))
      return "{}";
   string json = "{";
   json += "\"positionTicket\":" + IntegerToString((long)ticket) + ",";
   json += "\"orderTicket\":" + IntegerToString((long)PositionGetInteger(POSITION_IDENTIFIER)) + ",";
   json += "\"dealTicket\":null,";
   json += "\"symbol\":\"" + PositionGetString(POSITION_SYMBOL) + "\",";
   json += "\"direction\":\"" + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\",";
   json += "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 8) + ",";
   json += "\"entryPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 8) + ",";
   json += "\"stopLoss\":" + DoubleToString(PositionGetDouble(POSITION_SL), 8) + ",";
   json += "\"takeProfit\":" + DoubleToString(PositionGetDouble(POSITION_TP), 8) + ",";
   json += "\"currentPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), 8) + ",";
   json += "\"floatingPnl\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ",";
   json += "\"magic\":" + IntegerToString(PositionGetInteger(POSITION_MAGIC)) + ",";
   json += "\"comment\":\"" + PositionGetString(POSITION_COMMENT) + "\",";
   json += "\"openedAt\":" + IntegerToString((long)PositionGetInteger(POSITION_TIME) * 1000) + ",";
   json += "\"swap\":" + DoubleToString(PositionGetDouble(POSITION_SWAP), 2);
   json += "}";
   return json;
  }

string AllPositionsJson()
  {
   string json = "[";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(i > 0)
         json += ",";
      json += PositionJson(ticket);
     }
   json += "]";
   return json;
  }

string AllSymbolsJson()
  {
   string json = "[";
   int total = SymbolsTotal(true);
   int written = 0;
   for(int i = 0; i < total; i++)
     {
      string name = SymbolName(i, true);
      if(written > 0)
         json += ",";
      json += SymbolJson(name);
      written++;
      if(written >= 400)
         break;
     }
   json += "]";
   return json;
  }

string FillingModesJson(uint filling)
  {
   string modes = "[";
   bool first = true;
   if((filling & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
     {
      modes += "\"FOK\"";
      first = false;
     }
   if((filling & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
     {
      if(!first)
         modes += ",";
      modes += "\"IOC\"";
      first = false;
     }
   if(first)
      modes += "\"RETURN\"";
   modes += "]";
   return modes;
  }

string SelectedFillingName(ENUM_ORDER_TYPE_FILLING filling)
  {
   if(filling == ORDER_FILLING_FOK)
      return "FOK";
   if(filling == ORDER_FILLING_IOC)
      return "IOC";
   if(filling == ORDER_FILLING_RETURN)
      return "RETURN";
   return "UNKNOWN";
  }

bool SelectFillingMode(string symbol, ENUM_ORDER_TYPE_FILLING &filling)
  {
   uint mask = (uint)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((mask & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
     {
      filling = ORDER_FILLING_FOK;
      return true;
     }
   if((mask & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
     {
      filling = ORDER_FILLING_IOC;
      return true;
     }
   filling = ORDER_FILLING_RETURN;
   return true;
  }

bool ApplyRequestedFilling(string requested, string symbol, ENUM_ORDER_TYPE_FILLING &filling)
  {
   uint mask = (uint)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if(requested == "FOK")
     {
      if((mask & SYMBOL_FILLING_FOK) != SYMBOL_FILLING_FOK)
         return false;
      filling = ORDER_FILLING_FOK;
      return true;
     }
   if(requested == "IOC")
     {
      if((mask & SYMBOL_FILLING_IOC) != SYMBOL_FILLING_IOC)
         return false;
      filling = ORDER_FILLING_IOC;
      return true;
     }
   if(requested == "RETURN")
     {
      if((mask & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK || (mask & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
         return false;
      filling = ORDER_FILLING_RETURN;
      return true;
     }
   return SelectFillingMode(symbol, filling);
  }

string DealReasonName(long reason)
  {
   if(reason == DEAL_REASON_CLIENT)
      return "CLIENT";
   if(reason == DEAL_REASON_MOBILE)
      return "MOBILE";
   if(reason == DEAL_REASON_WEB)
      return "WEB";
   if(reason == DEAL_REASON_EXPERT)
      return "EXPERT";
   if(reason == DEAL_REASON_SL)
      return "SL";
   if(reason == DEAL_REASON_TP)
      return "TP";
   if(reason == DEAL_REASON_SO)
      return "SO";
   if(reason == DEAL_REASON_ROLLOVER)
      return "ROLLOVER";
   if(reason == DEAL_REASON_VMARGIN)
      return "VMARGIN";
   if(reason == DEAL_REASON_SPLIT)
      return "SPLIT";
   return "UNKNOWN";
  }

string DealEntryName(long entry)
  {
   if(entry == DEAL_ENTRY_IN)
      return "IN";
   if(entry == DEAL_ENTRY_OUT)
      return "OUT";
   if(entry == DEAL_ENTRY_INOUT)
      return "INOUT";
   return "UNKNOWN";
  }

string DealJson(ulong ticket)
  {
   if(!HistoryDealSelect(ticket))
      return "{}";
   string json = "{";
   json += "\"dealTicket\":" + IntegerToString((long)ticket) + ",";
   json += "\"orderTicket\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_ORDER)) + ",";
   json += "\"positionTicket\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_POSITION_ID)) + ",";
   json += "\"symbol\":\"" + HistoryDealGetString(ticket, DEAL_SYMBOL) + "\",";
   json += "\"direction\":\"" + (HistoryDealGetInteger(ticket, DEAL_TYPE) == DEAL_TYPE_SELL ? "SELL" : "BUY") + "\",";
   json += "\"volume\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_VOLUME), 8) + ",";
   json += "\"price\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PRICE), 8) + ",";
   json += "\"profit\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) + ",";
   json += "\"commission\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2) + ",";
   json += "\"swap\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_SWAP), 2) + ",";
   json += "\"fee\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_FEE), 2) + ",";
   json += "\"comment\":\"" + HistoryDealGetString(ticket, DEAL_COMMENT) + "\",";
   json += "\"magic\":" + IntegerToString(HistoryDealGetInteger(ticket, DEAL_MAGIC)) + ",";
   json += "\"time\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_TIME) * 1000) + ",";
   json += "\"entry\":\"" + DealEntryName(HistoryDealGetInteger(ticket, DEAL_ENTRY)) + "\",";
   json += "\"reason\":\"" + DealReasonName(HistoryDealGetInteger(ticket, DEAL_REASON)) + "\",";
   json += "\"reasonRaw\":\"" + DealReasonName(HistoryDealGetInteger(ticket, DEAL_REASON)) + "\"";
   json += "}";
   return json;
  }

void HandleHistory(string json, string requestId, string idempotencyKey, string command)
  {
   long magicFilter = (long)JsonGetNumber(json, "magic", (double)InpMagic);
   long positionFilter = (long)JsonGetNumber(json, "positionTicket", 0);
   long orderFilter = (long)JsonGetNumber(json, "orderTicket", 0);
   long dealFilter = (long)JsonGetNumber(json, "dealTicket", 0);
   datetime from = TimeCurrent() - 30 * 24 * 60 * 60;
   datetime to = TimeCurrent() + 60;
   double fromMs = JsonGetNumber(json, "fromMs", 0);
   double toMs = JsonGetNumber(json, "toMs", 0);
   if(fromMs > 0)
      from = (datetime)(fromMs / 1000.0);
   if(toMs > 0)
      to = (datetime)(toMs / 1000.0);
   if(!HistorySelect(from, to))
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_HISTORY_UNAVAILABLE", "", "", true);
      return;
     }
   string result = "[";
   int written = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0 || !HistoryDealSelect(ticket))
         continue;
      long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if(magicFilter != 0 && magic != magicFilter)
         continue;
      if(positionFilter != 0 && HistoryDealGetInteger(ticket, DEAL_POSITION_ID) != positionFilter)
         continue;
      if(orderFilter != 0 && HistoryDealGetInteger(ticket, DEAL_ORDER) != orderFilter)
         continue;
      if(dealFilter != 0 && (long)ticket != dealFilter)
         continue;
      if(written > 0)
         result += ",";
      result += DealJson(ticket);
      written++;
     }
   result += "]";
   WriteReply(requestId, idempotencyKey, command, true, "", "", result, false);
  }

bool EnsureSymbol(string symbol)
  {
   if(!SymbolSelect(symbol, true))
      return false;
   return SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE) != SYMBOL_TRADE_MODE_DISABLED;
  }

void HandleOpen(string json, string requestId, string idempotencyKey, string command)
  {
   string payload = json;
   string symbol = JsonGetString(payload, "symbol");
   string direction = JsonGetString(payload, "direction");
   double volume = JsonGetNumber(payload, "volume", 0);
   double sl = JsonGetNumber(payload, "stopLoss", 0);
   double tp = JsonGetNumber(payload, "takeProfit", 0);
   string comment = JsonGetString(payload, "comment");
   long magic = (long)JsonGetNumber(payload, "magic", (double)InpMagic);

   if(!EnsureSymbol(symbol))
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_SYMBOL_NOT_TRADEABLE", symbol, "", false);
      return;
     }
   double vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(volume + 1e-12 < vmin || volume - 1e-12 > vmax)
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_VOLUME_INVALID", DoubleToString(volume, 8), "", false);
      return;
     }

   string fillingRequested = JsonGetString(payload, "fillingMode");
   ENUM_ORDER_TYPE_FILLING filling;
   if(!ApplyRequestedFilling(fillingRequested, symbol, filling))
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_FILLING_MODE_UNSUPPORTED", fillingRequested, "", false);
      return;
     }
   long tradeMode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if(direction == "BUY" && tradeMode == SYMBOL_TRADE_MODE_SHORTONLY)
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_ORDER_TYPE_UNSUPPORTED", direction, "", false);
      return;
     }
   if(direction == "SELL" && tradeMode == SYMBOL_TRADE_MODE_LONGONLY)
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_ORDER_TYPE_UNSUPPORTED", direction, "", false);
      return;
     }

   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_DEAL;
   req.symbol = symbol;
   req.volume = volume;
   req.type = (direction == "SELL" ? ORDER_TYPE_SELL : ORDER_TYPE_BUY);
   req.price = (req.type == ORDER_TYPE_BUY ? SymbolInfoDouble(symbol, SYMBOL_ASK) : SymbolInfoDouble(symbol, SYMBOL_BID));
   req.sl = sl;
   req.tp = tp;
   req.deviation = 50;
   req.magic = magic;
   req.comment = comment;
   req.type_filling = filling;

   if(!OrderSend(req, res))
     {
      WriteReply(requestId, idempotencyKey, command, false, "ORDER_SEND_FAILED", IntegerToString(res.retcode), "", false);
      return;
     }
   if(res.retcode != TRADE_RETCODE_DONE && res.retcode != TRADE_RETCODE_DONE_PARTIAL)
     {
      WriteReply(requestId, idempotencyKey, command, false, "TRADE_RETCODE_" + IntegerToString(res.retcode), res.comment, "", false);
      return;
     }

   ulong positionTicket = res.order;
   if(res.deal > 0 && HistoryDealSelect(res.deal))
      positionTicket = (ulong)HistoryDealGetInteger(res.deal, DEAL_POSITION_ID);

   string result = "{";
   result += "\"positionTicket\":" + IntegerToString((long)positionTicket) + ",";
   result += "\"orderTicket\":" + IntegerToString((long)res.order) + ",";
   result += "\"dealTicket\":" + IntegerToString((long)res.deal) + ",";
   result += "\"fillPrice\":" + DoubleToString(res.price, 8) + ",";
   result += "\"volume\":" + DoubleToString(res.volume, 8) + ",";
   result += "\"stopLoss\":" + DoubleToString(sl, 8) + ",";
   result += "\"takeProfit\":" + DoubleToString(tp, 8) + ",";
   result += "\"comment\":\"" + comment + "\",";
   result += "\"magic\":" + IntegerToString(magic) + ",";
   result += "\"fillingMode\":\"" + SelectedFillingName(filling) + "\",";
   result += "\"brokerStatus\":\"FILLED\"";
   result += "}";
   WriteReply(requestId, idempotencyKey, command, true, "", "", result, false);
  }

void HandleModify(string json, string requestId, string idempotencyKey, string command)
  {
   ulong ticket = (ulong)JsonGetNumber(json, "positionTicket", 0);
   if(!PositionSelectByTicket(ticket))
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_POSITION_NOT_FOUND", "", "", false);
      return;
     }
   double sl = JsonGetNumber(json, "stopLoss", PositionGetDouble(POSITION_SL));
   double tp = JsonGetNumber(json, "takeProfit", PositionGetDouble(POSITION_TP));
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_SLTP;
   req.position = ticket;
   req.symbol = PositionGetString(POSITION_SYMBOL);
   req.sl = sl;
   req.tp = tp;
   req.magic = InpMagic;
   if(!OrderSend(req, res) || (res.retcode != TRADE_RETCODE_DONE && res.retcode != TRADE_RETCODE_NO_CHANGES))
     {
      WriteReply(requestId, idempotencyKey, command, false, "MODIFY_FAILED", IntegerToString(res.retcode), "", false);
      return;
     }
   WriteReply(requestId, idempotencyKey, command, true, "", "", PositionJson(ticket), false);
  }

void HandleClose(string json, string requestId, string idempotencyKey, string command)
  {
   ulong ticket = (ulong)JsonGetNumber(json, "positionTicket", 0);
   if(!PositionSelectByTicket(ticket))
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_POSITION_NOT_FOUND", "", "", false);
      return;
     }
   string symbol = PositionGetString(POSITION_SYMBOL);
   double volume = PositionGetDouble(POSITION_VOLUME);
   long type = PositionGetInteger(POSITION_TYPE);
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_DEAL;
   req.position = ticket;
   req.symbol = symbol;
   req.volume = volume;
   req.type = (type == POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY);
   req.price = (req.type == ORDER_TYPE_SELL ? SymbolInfoDouble(symbol, SYMBOL_BID) : SymbolInfoDouble(symbol, SYMBOL_ASK));
   req.deviation = 50;
   req.magic = InpMagic;
   ENUM_ORDER_TYPE_FILLING filling;
   if(!SelectFillingMode(symbol, filling))
     {
      WriteReply(requestId, idempotencyKey, command, false, "MT5_FILLING_MODE_UNSUPPORTED", "", "", false);
      return;
     }
   req.comment = "RX-CLOSE";
   req.type_filling = filling;
   if(!OrderSend(req, res) || (res.retcode != TRADE_RETCODE_DONE && res.retcode != TRADE_RETCODE_DONE_PARTIAL))
     {
      WriteReply(requestId, idempotencyKey, command, false, "CLOSE_FAILED", IntegerToString(res.retcode), "", false);
      return;
     }
   double realized = 0;
   if(res.deal > 0 && HistoryDealSelect(res.deal))
      realized = HistoryDealGetDouble(res.deal, DEAL_PROFIT);
   string result = "{";
   result += "\"positionTicket\":" + IntegerToString((long)ticket) + ",";
   result += "\"closePrice\":" + DoubleToString(res.price, 8) + ",";
   result += "\"realizedPnl\":" + DoubleToString(realized, 2) + ",";
   result += "\"dealTicket\":" + IntegerToString((long)res.deal) + ",";
   result += "\"closedAt\":" + IntegerToString((long)TimeGMT() * 1000);
   result += "}";
   WriteReply(requestId, idempotencyKey, command, true, "", "", result, false);
  }

void ProcessCommandFile(string filename)
  {
   if(IsTempName(filename))
      return;
   string pending = MailboxPath("commands\\pending") + "\\" + filename;
   string processing = MailboxPath("commands\\processing") + "\\" + filename;
   if(!FileIsExist(pending))
      return;
   if(!FileMove(pending, 0, processing, FILE_REWRITE))
      return;

   int h = FileOpen(processing, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      return;
     }
   string json = "";
   while(!FileIsEnding(h))
      json += FileReadString(h);
   FileClose(h);

   string requestId = JsonGetString(json, "requestId");
   string idempotencyKey = JsonGetString(json, "idempotencyKey");
   string command = JsonGetString(json, "command");
   if(requestId == "" || command == "")
      return;

   if(command == "ping")
      WriteReply(requestId, idempotencyKey, command, true, "", "", "{\"pong\":true}", false);
   else if(command == "getAccount")
      WriteReply(requestId, idempotencyKey, command, true, "", "", AccountJson(), false);
   else if(command == "getSymbols")
      WriteReply(requestId, idempotencyKey, command, true, "", "", AllSymbolsJson(), false);
   else if(command == "getInstrument")
      WriteReply(requestId, idempotencyKey, command, true, "", "", SymbolJson(JsonGetString(json, "symbol")), false);
   else if(command == "getQuote")
     {
      string symbol = JsonGetString(json, "symbol");
      string q = "{";
      q += "\"symbol\":\"" + symbol + "\",";
      q += "\"bid\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_BID), 8) + ",";
      q += "\"ask\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_ASK), 8) + ",";
      q += "\"timestamp\":" + IntegerToString((long)TimeGMT() * 1000);
      q += "}";
      WriteReply(requestId, idempotencyKey, command, true, "", "", q, false);
     }
   else if(command == "getOpenPositions")
      WriteReply(requestId, idempotencyKey, command, true, "", "", AllPositionsJson(), false);
   else if(command == "getHistory")
      HandleHistory(json, requestId, idempotencyKey, command);
   else if(command == "openMarket")
      HandleOpen(json, requestId, idempotencyKey, command);
   else if(command == "modifyPosition")
      HandleModify(json, requestId, idempotencyKey, command);
   else if(command == "closePosition")
      HandleClose(json, requestId, idempotencyKey, command);
   else
      WriteReply(requestId, idempotencyKey, command, false, "UNKNOWN_COMMAND", command, "", false);
  }

void ScanPending()
  {
   string filter = MailboxPath("commands\\pending") + "\\*.json";
   string filename;
   long search = FileFindFirst(filter, filename);
   if(search == INVALID_HANDLE)
      return;
   do
     {
      if(!IsTempName(filename))
         ProcessCommandFile(filename);
     }
   while(FileFindNext(search, filename));
   FileFindClose(search);
  }

int OnInit()
  {
   FolderCreate(InpMailboxRoot);
   FolderCreate(MailboxPath("commands"));
   FolderCreate(MailboxPath("commands\\pending"));
   FolderCreate(MailboxPath("commands\\processing"));
   FolderCreate(MailboxPath("replies"));
   FolderCreate(MailboxPath("events"));
   EventSetMillisecondTimer(InpTimerMs);
   WriteReply("ea-ready", "ea-ready", "ping", true, "", "", AccountJson(), false);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   ScanPending();
  }

void OnTick()
  {
  }
